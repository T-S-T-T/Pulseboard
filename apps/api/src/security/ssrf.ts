/**
 * Defence against server-side request forgery (SSRF). Users choose the URLs that
 * the server fetches, so every target must resolve only to public addresses.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export class UnsafeTargetError extends Error {}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface TargetPolicy {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  isAllowedAddress(address: string): boolean;
  isAllowedPort(port: number): boolean;
}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
  ['168.63.129.16', 32], // Azure platform endpoint
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4');
}

// IPv6 is an allow list: only global unicast, minus special ranges inside it.
// Everything else (loopback, link-local, unique-local, IPv4-mapped, NAT64) fails.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], // protocol assignments, including Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which embeds an IPv4 address
  ['3fff::', 20], // documentation
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blockedV4.check(address, 'ipv4');
    case 6:
      // Zone identifiers (fe80::1%eth0) are never public.
      if (address.includes('%')) return false;
      return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
    default:
      return false;
  }
}

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export const publicPolicy: TargetPolicy = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  isAllowedAddress: isPublicAddress,
  isAllowedPort: (port) => ALLOWED_PORTS.has(port),
};

export interface Target {
  url: URL;
  /** Hostname without IPv6 brackets. */
  hostname: string;
}

/**
 * Checks that need no network. Used when a URL is saved and again before every
 * request. DNS results are checked at request time by the probe.
 */
export function parseTarget(raw: string, policy: TargetPolicy = publicPolicy): Target {
  let url: URL;
  try {
    // The URL parser normalises tricks such as http://2130706433/ to 127.0.0.1.
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new UnsafeTargetError('URLs must not contain credentials');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!policy.isAllowedPort(port)) {
    throw new UnsafeTargetError('Port is not allowed (use 80, 443, 8080 or 8443)');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!policy.isAllowedAddress(hostname)) {
      throw new UnsafeTargetError('Address is not public');
    }
  } else {
    const name = hostname.replace(/\.+$/, '').toLowerCase();
    if (!name.includes('.') || /\.(localhost|local|internal)$/.test(name)) {
      throw new UnsafeTargetError('Hostname is not public');
    }
  }
  return { url, hostname };
}

/** Resolves a target and rejects it if ANY of its addresses is not allowed. */
export async function resolveTarget(
  target: Target,
  policy: TargetPolicy,
): Promise<ResolvedAddress[]> {
  const family = isIP(target.hostname);
  const addresses = family
    ? [{ address: target.hostname, family }]
    : await policy.resolve(target.hostname);
  if (addresses.length === 0) {
    throw new UnsafeTargetError('Hostname has no addresses');
  }
  if (!addresses.every((a) => policy.isAllowedAddress(a.address))) {
    throw new UnsafeTargetError('Hostname resolves to a non-public address');
  }
  return addresses;
}
