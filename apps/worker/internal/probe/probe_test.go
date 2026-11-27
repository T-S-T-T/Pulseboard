package probe

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

var loopback = netip.MustParseAddr("127.0.0.1")

// localPolicy is a test-only policy that reaches a local server.
func localPolicy() Policy {
	return Policy{
		Resolve:      func(context.Context, string) ([]netip.Addr, error) { return []netip.Addr{loopback}, nil },
		AllowAddress: func(a netip.Addr) bool { return a == loopback },
		AllowPort:    func(uint16) bool { return true },
	}
}

type server struct {
	port string
	mu   sync.Mutex
	hits []string
}

func startServer(t *testing.T) *server {
	t.Helper()
	s := &server{}
	release := make(chan struct{})
	test := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits = append(s.hits, r.Method+" "+r.URL.Path)
		s.mu.Unlock()
		switch r.URL.Path {
		case "/slow":
			<-release
		case "/redirect":
			http.Redirect(w, r, "/secret", http.StatusFound)
		case "/broken":
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	// Cleanups run last first: release the slow handler, then close.
	t.Cleanup(test.Close)
	t.Cleanup(func() { close(release) })
	parsed, _ := url.Parse(test.URL)
	s.port = parsed.Port()
	return s
}

func (s *server) seen() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.hits, ", ")
}

// The name does not exist in DNS, so only a pinned address can answer.
func (s *server) check(path string, policy Policy) Result {
	return Check(context.Background(), Request{
		URL:     "http://service.example.test:" + s.port + path,
		Method:  http.MethodGet,
		Timeout: time.Second,
	}, policy)
}

func message(result Result) string {
	if result.Error == nil {
		return ""
	}
	return *result.Error
}

func expect(t *testing.T, result Result, ok bool, status int, errorText string) {
	t.Helper()
	got := 0
	if result.StatusCode != nil {
		got = *result.StatusCode
	}
	if result.OK != ok || got != status || message(result) != errorText {
		t.Errorf("got ok=%v status=%d error=%q, want ok=%v status=%d error=%q",
			result.OK, got, message(result), ok, status, errorText)
	}
}

func TestStatuses(t *testing.T) {
	s := startServer(t)
	expect(t, s.check("/ok", localPolicy()), true, 200, "")
	expect(t, s.check("/broken", localPolicy()), false, 500, "HTTP 500")
}

func TestDoesNotFollowRedirects(t *testing.T) {
	s := startServer(t)
	expect(t, s.check("/redirect", localPolicy()), true, 302, "")
	if got := s.seen(); got != "GET /redirect" {
		t.Errorf("requests: %s", got)
	}
}

func TestDeadline(t *testing.T) {
	s := startServer(t)
	expect(t, s.check("/slow", localPolicy()), false, 0, "Timed out")

	hanging := localPolicy()
	release := make(chan struct{})
	defer close(release)
	hanging.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		<-release // ignores the deadline
		return nil, nil
	}
	expect(t, s.check("/ok", hanging), false, 0, "Timed out")
}

func TestConnectionRefused(t *testing.T) {
	result := Check(context.Background(), Request{
		URL: "http://service.example.test:1/", Method: "GET", Timeout: 5 * time.Second,
	}, localPolicy())
	expect(t, result, false, 0, "Connection refused")
}

func TestDNSFailure(t *testing.T) {
	result := Check(context.Background(), Request{
		URL: "http://does-not-exist.invalid/", Method: "GET", Timeout: 10 * time.Second,
	}, PublicPolicy())
	expect(t, result, false, 0, "DNS lookup failed")
}

func TestUntrustedCertificate(t *testing.T) {
	test := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer test.Close()
	parsed, _ := url.Parse(test.URL)
	result := Check(context.Background(), Request{
		URL: "https://service.example.test:" + parsed.Port() + "/", Method: "GET", Timeout: time.Second,
	}, localPolicy())
	expect(t, result, false, 0, "TLS error")
}

func TestNeverConnectsToPrivateAddresses(t *testing.T) {
	s := startServer(t)
	policy := PublicPolicy()
	policy.AllowPort = func(uint16) bool { return true }
	policy.Resolve = localPolicy().Resolve

	byName := s.check("/ok", policy)
	byAddress := Check(context.Background(), Request{
		URL: "http://127.0.0.1:" + s.port + "/ok", Method: "GET", Timeout: time.Second,
	}, policy)
	for _, result := range []Result{byName, byAddress} {
		if !strings.HasPrefix(message(result), "Blocked:") {
			t.Errorf("not blocked: %q", message(result))
		}
	}
	if got := s.seen(); got != "" {
		t.Errorf("the server was reached: %s", got)
	}
}

func TestResolvesOnlyOnce(t *testing.T) {
	s := startServer(t)
	lookups := 0
	rebinding := localPolicy()
	rebinding.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		lookups++
		if lookups == 1 {
			return []netip.Addr{loopback}, nil
		}
		return []netip.Addr{netip.MustParseAddr("10.0.0.1")}, nil
	}
	expect(t, s.check("/ok", rebinding), true, 200, "")
	if lookups != 1 {
		t.Errorf("resolved %d times", lookups)
	}
}

func TestTriesTheNextAddress(t *testing.T) {
	s := startServer(t)
	// Nothing listens on the first address.
	other := netip.MustParseAddr("127.0.0.2")
	policy := localPolicy()
	policy.AllowAddress = func(a netip.Addr) bool { return a == loopback || a == other }
	policy.Resolve = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{other, loopback}, nil
	}
	expect(t, s.check("/ok", policy), true, 200, "")
}

func TestIgnoresProxySettings(t *testing.T) {
	s := startServer(t)
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	expect(t, s.check("/ok", localPolicy()), true, 200, "")
}

func TestOnlyGetAndHead(t *testing.T) {
	s := startServer(t)
	result := Check(context.Background(), Request{
		URL: "http://service.example.test:" + s.port + "/", Method: "DELETE", Timeout: time.Second,
	}, localPolicy())
	expect(t, result, false, 0, "Blocked: Method is not allowed")
	if got := s.seen(); got != "" {
		t.Errorf("the server was reached: %s", got)
	}
}
