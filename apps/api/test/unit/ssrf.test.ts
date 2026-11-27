import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  parseTarget,
  publicPolicy,
  resolveTarget,
  UnsafeTargetError,
} from '../../src/security/ssrf.js';

/** Cases shared with the Go implementation in apps/worker. */
const cases = JSON.parse(
  readFileSync(new URL('../../../../testdata/ssrf-cases.json', import.meta.url), 'utf8'),
) as {
  publicAddresses: string[];
  blockedAddresses: string[];
  allowedUrls: { url: string; hostname: string }[];
  rejectedUrls: string[];
  resolutions: { addresses: string[]; allowed: boolean }[];
};

describe('isPublicAddress', () => {
  it.each(cases.publicAddresses)('allows %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );

  it.each(cases.blockedAddresses)('blocks %j', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
});

describe('parseTarget', () => {
  it.each(cases.allowedUrls)('accepts $url', ({ url, hostname }) => {
    expect(parseTarget(url).hostname).toBe(hostname);
  });

  it.each(cases.rejectedUrls)('rejects %j', (url) =>
    expect(() => parseTarget(url)).toThrow(UnsafeTargetError),
  );
});

describe('resolveTarget', () => {
  const target = parseTarget('https://example.com/');

  it.each(cases.resolutions)('$addresses: allowed is $allowed', async ({ addresses, allowed }) => {
    const resolved = addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    const attempt = resolveTarget(target, { ...publicPolicy, resolve: async () => resolved });
    if (allowed) await expect(attempt).resolves.toEqual(resolved);
    else await expect(attempt).rejects.toThrow(UnsafeTargetError);
  });
});
