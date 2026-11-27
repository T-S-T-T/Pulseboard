package probe

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"testing"
)

// The cases shared with the TypeScript implementation.
type cases struct {
	PublicAddresses  []string `json:"publicAddresses"`
	BlockedAddresses []string `json:"blockedAddresses"`
	AllowedURLs      []struct {
		URL      string `json:"url"`
		Hostname string `json:"hostname"`
	} `json:"allowedUrls"`
	RejectedURLs []string `json:"rejectedUrls"`
	Resolutions  []struct {
		Addresses []string `json:"addresses"`
		Allowed   bool     `json:"allowed"`
	} `json:"resolutions"`
}

func loadCases(t *testing.T) cases {
	t.Helper()
	data, err := os.ReadFile("../../../../testdata/ssrf-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var result cases
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	// Guards against a renamed key silently testing nothing.
	if len(result.PublicAddresses) == 0 || len(result.BlockedAddresses) == 0 ||
		len(result.AllowedURLs) == 0 || len(result.RejectedURLs) == 0 || len(result.Resolutions) == 0 {
		t.Fatal("a group of shared cases is empty")
	}
	return result
}

// isPublic treats anything that is not an address as not public.
func isPublic(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && IsPublicAddress(address)
}

func TestIsPublicAddress(t *testing.T) {
	shared := loadCases(t)
	for _, address := range shared.PublicAddresses {
		if !isPublic(address) {
			t.Errorf("%q should be public", address)
		}
	}
	for _, address := range shared.BlockedAddresses {
		if isPublic(address) {
			t.Errorf("%q should be blocked", address)
		}
	}
}

func TestParseTarget(t *testing.T) {
	shared := loadCases(t)
	for _, c := range shared.AllowedURLs {
		target, err := ParseTarget(c.URL, PublicPolicy())
		if err != nil {
			t.Errorf("%q should be accepted: %v", c.URL, err)
		} else if target.Hostname != c.Hostname {
			t.Errorf("%q: hostname %q, want %q", c.URL, target.Hostname, c.Hostname)
		}
	}
	for _, url := range shared.RejectedURLs {
		_, err := ParseTarget(url, PublicPolicy())
		var unsafe *UnsafeTargetError
		if !errors.As(err, &unsafe) {
			t.Errorf("%q should be rejected, got %v", url, err)
		}
	}
}

func TestResolveTarget(t *testing.T) {
	target, err := ParseTarget("https://example.com/", PublicPolicy())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range loadCases(t).Resolutions {
		addresses := []netip.Addr{}
		for _, value := range c.Addresses {
			addresses = append(addresses, netip.MustParseAddr(value))
		}
		policy := PublicPolicy()
		policy.Resolve = func(context.Context, string) ([]netip.Addr, error) { return addresses, nil }
		_, err := ResolveTarget(context.Background(), target, policy)
		if (err == nil) != c.Allowed {
			t.Errorf("%v: allowed should be %v, got error %v", c.Addresses, c.Allowed, err)
		}
	}
}

// FuzzParseTarget looks for input that panics, or that is accepted although it
// names a non-public address.
func FuzzParseTarget(f *testing.F) {
	for _, seed := range []string{"https://example.com/", "http://[::1]:80/", "http://127.1/", "http://a.b:8080"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		target, err := ParseTarget(raw, PublicPolicy())
		if err != nil {
			return
		}
		if address, err := netip.ParseAddr(target.Hostname); err == nil && !IsPublicAddress(address) {
			t.Errorf("accepted non-public address from %q", raw)
		}
		if target.URL.User != nil {
			t.Errorf("accepted credentials in %q", raw)
		}
	})
}
