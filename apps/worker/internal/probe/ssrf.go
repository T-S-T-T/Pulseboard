// Package probe makes health checks of user-supplied URLs.
//
// This file defends against server-side request forgery (SSRF): users choose
// the URLs that the server fetches, so every target must resolve only to public
// addresses. It mirrors apps/api/src/security/ssrf.ts, and both are tested
// against testdata/ssrf-cases.json.
package probe

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// UnsafeTargetError reports a target that must not be contacted.
type UnsafeTargetError struct{ Reason string }

func (e *UnsafeTargetError) Error() string { return e.Reason }

func unsafeTarget(reason string) error { return &UnsafeTargetError{Reason: reason} }

// Policy decides what may be contacted. Production code uses PublicPolicy.
type Policy struct {
	Resolve      func(ctx context.Context, hostname string) ([]netip.Addr, error)
	AllowAddress func(netip.Addr) bool
	AllowPort    func(uint16) bool
}

// PublicPolicy allows only public addresses on the usual web ports.
func PublicPolicy() Policy {
	return Policy{
		Resolve:      lookup,
		AllowAddress: IsPublicAddress,
		AllowPort: func(port uint16) bool {
			return port == 80 || port == 443 || port == 8080 || port == 8443
		},
	}
}

func lookup(ctx context.Context, hostname string) ([]netip.Addr, error) {
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", hostname)
	// The resolver may return IPv4 answers in IPv4-mapped IPv6 form. The same
	// unmapped value is both checked and dialled.
	for i := range addresses {
		addresses[i] = addresses[i].Unmap()
	}
	return addresses, err
}

func prefixes(values ...string) []netip.Prefix {
	result := make([]netip.Prefix, len(values))
	for i, value := range values {
		result[i] = netip.MustParsePrefix(value)
	}
	return result
}

var blockedV4 = prefixes(
	"0.0.0.0/8",        // "this" network
	"10.0.0.0/8",       // private
	"100.64.0.0/10",    // carrier-grade NAT
	"127.0.0.0/8",      // loopback
	"169.254.0.0/16",   // link-local, including cloud metadata
	"172.16.0.0/12",    // private
	"192.0.0.0/24",     // protocol assignments
	"192.0.2.0/24",     // documentation
	"192.88.99.0/24",   // 6to4 relay
	"192.168.0.0/16",   // private
	"198.18.0.0/15",    // benchmarking
	"198.51.100.0/24",  // documentation
	"203.0.113.0/24",   // documentation
	"224.0.0.0/4",      // multicast
	"240.0.0.0/4",      // reserved and broadcast
	"168.63.129.16/32", // Azure platform endpoint
)

// IPv6 is an allow list: only global unicast, minus special ranges inside it.
// Everything else (loopback, link-local, unique-local, IPv4-mapped, NAT64) fails.
var globalV6 = netip.MustParsePrefix("2000::/3")

var blockedV6 = prefixes(
	"2001::/23",     // protocol assignments, including Teredo
	"2001:db8::/32", // documentation
	"2002::/16",     // 6to4, which embeds an IPv4 address
	"3fff::/20",     // documentation
)

// IsPublicAddress reports whether an address is on the public internet.
func IsPublicAddress(address netip.Addr) bool {
	contains := func(p netip.Prefix) bool { return p.Contains(address) }
	switch {
	case address.Is4():
		return !slices.ContainsFunc(blockedV4, contains)
	case address.Is6():
		// Zone identifiers (fe80::1%eth0) are never public.
		if address.Zone() != "" {
			return false
		}
		return globalV6.Contains(address) && !slices.ContainsFunc(blockedV6, contains)
	default:
		return false
	}
}

// Target is a URL that passed the checks needing no network.
type Target struct {
	URL *url.URL
	// Hostname is lower case, without IPv6 brackets.
	Hostname string
	Port     uint16
}

// ParseTarget makes the checks that need no network. Addresses found through DNS
// are checked at request time by ResolveTarget.
//
// It is stricter than the TypeScript version about unusual spellings: where a
// browser would rewrite http://8.8.8.8./ to an address, this rejects it. The API
// stores URLs already rewritten, so workers only see the normal form.
func ParseTarget(raw string, policy Policy) (Target, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return Target{}, unsafeTarget("Not a valid URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Target{}, unsafeTarget("Only http and https URLs are allowed")
	}
	if parsed.User != nil {
		return Target{}, unsafeTarget("URLs must not contain credentials")
	}

	port := uint64(80)
	if parsed.Scheme == "https" {
		port = 443
	}
	if value := parsed.Port(); value != "" {
		if port, err = strconv.ParseUint(value, 10, 16); err != nil {
			return Target{}, unsafeTarget("Not a valid URL")
		}
	}
	if !policy.AllowPort(uint16(port)) {
		return Target{}, unsafeTarget("Port is not allowed (use 80, 443, 8080 or 8443)")
	}

	hostname := strings.ToLower(parsed.Hostname())
	bracketed := strings.HasPrefix(parsed.Host, "[")
	if address, err := netip.ParseAddr(hostname); err == nil {
		// IPv6 must be in brackets, and nothing else may be.
		if address.Is6() != bracketed {
			return Target{}, unsafeTarget("Not a valid URL")
		}
		if !policy.AllowAddress(address) {
			return Target{}, unsafeTarget("Address is not public")
		}
	} else {
		if bracketed || !isHostname(hostname) {
			return Target{}, unsafeTarget("Not a valid URL")
		}
		name := strings.TrimRight(hostname, ".")
		if !strings.Contains(name, ".") || hasSuffix(name, ".localhost", ".local", ".internal") {
			return Target{}, unsafeTarget("Hostname is not public")
		}
		// Some resolvers read names such as 127.1 or 0x7f.0.0.1 as addresses.
		if isNumber(name[strings.LastIndex(name, ".")+1:]) {
			return Target{}, unsafeTarget("Hostname is not public")
		}
	}
	return Target{URL: parsed, Hostname: hostname, Port: uint16(port)}, nil
}

// isHostname accepts ASCII names only. The API stores international names in
// their ASCII (punycode) form.
func isHostname(value string) bool {
	return value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.')
	}) < 0
}

func isNumber(label string) bool {
	digits := "0123456789"
	if rest, found := strings.CutPrefix(label, "0x"); found {
		label, digits = rest, "0123456789abcdef"
		if label == "" {
			return true
		}
	}
	return label != "" && strings.Trim(label, digits) == ""
}

func hasSuffix(value string, suffixes ...string) bool {
	return slices.ContainsFunc(suffixes, func(s string) bool { return strings.HasSuffix(value, s) })
}

// ResolveTarget returns the target's addresses, and rejects it if ANY of them is
// not allowed.
func ResolveTarget(ctx context.Context, target Target, policy Policy) ([]netip.Addr, error) {
	var addresses []netip.Addr
	if address, err := netip.ParseAddr(target.Hostname); err == nil {
		addresses = []netip.Addr{address}
	} else if addresses, err = policy.Resolve(ctx, target.Hostname); err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, unsafeTarget("Hostname has no addresses")
	}
	for _, address := range addresses {
		if !policy.AllowAddress(address) {
			return nil, unsafeTarget("Hostname resolves to a non-public address")
		}
	}
	return addresses, nil
}
