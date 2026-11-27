package probe

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"syscall"
	"time"
)

// Request describes one health check.
type Request struct {
	URL     string
	Method  string // GET or HEAD
	Timeout time.Duration
}

// Result is the outcome of a check. Its JSON form matches the API's.
type Result struct {
	OK         bool    `json:"ok"`
	StatusCode *int    `json:"statusCode"`
	LatencyMs  *int    `json:"latencyMs"`
	Error      *string `json:"error"`
}

// Check makes one health check. Every failure becomes a Result.
//
// Safety properties:
//   - the connection is pinned to the addresses that passed the policy, so a DNS
//     answer that changes after validation (DNS rebinding) has no effect;
//   - redirects are reported, never followed;
//   - proxy settings from the environment are ignored;
//   - the response body is discarded unread;
//   - one deadline covers DNS, connect, TLS and response headers.
func Check(ctx context.Context, request Request, policy Policy) Result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, request.Timeout)
	defer cancel()

	status, err := send(ctx, request, policy)
	if err != nil {
		message := describe(err)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			message = "Timed out"
		}
		return Result{Error: &message}
	}
	latency := int(time.Since(started).Round(time.Millisecond).Milliseconds())
	result := Result{OK: status >= 200 && status < 400, StatusCode: &status, LatencyMs: &latency}
	if !result.OK {
		message := fmt.Sprintf("HTTP %d", status)
		result.Error = &message
	}
	return result
}

func send(ctx context.Context, request Request, policy Policy) (int, error) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		return 0, unsafeTarget("Method is not allowed")
	}
	target, err := ParseTarget(request.URL, policy)
	if err != nil {
		return 0, err
	}
	addresses, err := resolveWithin(ctx, target, policy)
	if err != nil {
		return 0, err
	}

	// A transport per check: a connection validated for one is never reused.
	// Proxy stays nil, so the connection goes where the policy allowed.
	transport := &http.Transport{
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 32 << 10,
		// Ignores the address it is given and dials the validated ones.
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dial(ctx, network, addresses, target.Port)
		},
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	defer transport.CloseIdleConnections()

	outgoing, err := http.NewRequestWithContext(ctx, request.Method, target.URL.String(), nil)
	if err != nil {
		return 0, err
	}
	outgoing.Header.Set("User-Agent", "Pulseboard/0.1 (uptime check)")
	outgoing.Header.Set("Accept", "*/*")
	// RoundTrip, unlike http.Client, never follows a redirect.
	response, err := transport.RoundTrip(outgoing)
	if err != nil {
		return 0, err
	}
	_ = response.Body.Close()
	return response.StatusCode, nil
}

// resolveWithin applies the deadline even to a resolver that ignores it.
func resolveWithin(ctx context.Context, target Target, policy Policy) ([]netip.Addr, error) {
	type answer struct {
		addresses []netip.Addr
		err       error
	}
	done := make(chan answer, 1)
	go func() {
		addresses, err := ResolveTarget(ctx, target, policy)
		done <- answer{addresses, err}
	}()
	select {
	case a := <-done:
		return a.addresses, a.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// dial tries each address in turn, giving each an equal share of the time left,
// so one unreachable address cannot use it all.
func dial(ctx context.Context, network string, addresses []netip.Addr, port uint16) (net.Conn, error) {
	var firstErr error
	for i, address := range addresses {
		attempt, cancel := ctx, context.CancelFunc(func() {})
		if deadline, ok := ctx.Deadline(); ok {
			attempt, cancel = context.WithTimeout(ctx, time.Until(deadline)/time.Duration(len(addresses)-i))
		}
		var dialer net.Dialer
		connection, err := dialer.DialContext(attempt, network,
			net.JoinHostPort(address.String(), strconv.Itoa(int(port))))
		cancel()
		if err == nil {
			return connection, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// Windows reports socket errors with its own numbers.
var socketErrors = []struct {
	codes   []syscall.Errno
	message string
}{
	{[]syscall.Errno{syscall.ECONNREFUSED, 10061}, "Connection refused"},
	{[]syscall.Errno{syscall.ECONNRESET, 10054}, "Connection reset"},
	{[]syscall.Errno{syscall.EHOSTUNREACH, 10065}, "Host unreachable"},
	{[]syscall.Errno{syscall.ENETUNREACH, 10051}, "Network unreachable"},
	{[]syscall.Errno{syscall.ETIMEDOUT, 10060}, "Timed out"},
}

func describe(err error) string {
	var unsafe *UnsafeTargetError
	if errors.As(err, &unsafe) {
		return "Blocked: " + unsafe.Reason
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "DNS lookup failed"
	}
	for _, known := range socketErrors {
		for _, code := range known.codes {
			if errors.Is(err, code) {
				return known.message
			}
		}
	}
	var certificate *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	var alert tls.AlertError
	if errors.As(err, &certificate) || errors.As(err, &record) || errors.As(err, &alert) {
		return "TLS error"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "Timed out"
	}
	return "Request failed"
}
