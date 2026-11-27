import { describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  parseTarget,
  publicPolicy,
  resolveTarget,
  UnsafeTargetError,
} from '../../src/security/ssrf.js';

describe('isPublicAddress', () => {
  it.each(['1.1.1.1', '8.8.8.8', '93.184.215.14', '172.32.0.1', '2606:4700:4700::1111'])(
    'allows %s',
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '2001::1',
    'example.com',
    '',
  ])('blocks %j', (address) => expect(isPublicAddress(address)).toBe(false));
});

describe('parseTarget', () => {
  it('accepts ordinary web URLs', () => {
    expect(parseTarget('https://example.com/health?x=1').hostname).toBe('example.com');
    expect(parseTarget('http://8.8.8.8:8080/').hostname).toBe('8.8.8.8');
    expect(parseTarget('https://[2606:4700:4700::1111]/').hostname).toBe('2606:4700:4700::1111');
  });

  it.each([
    'file:///etc/passwd',
    'gopher://example.com/',
    'http://localhost/',
    'http://localhost./',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://intranet/',
    'http://127.1/',
    'http://0x7f.0.0.1/',
    'http://017700000001/',
    'http://[::ffff:7f00:1]/',
    'http://example.com:25/',
    'http://admin@example.com/',
    '//example.com',
  ])('rejects %s', (url) => expect(() => parseTarget(url)).toThrow(UnsafeTargetError));
});

describe('resolveTarget', () => {
  const resolvingTo = (...addresses: string[]) => ({
    ...publicPolicy,
    resolve: async () => addresses.map((address) => ({ address, family: 4 })),
  });
  const target = parseTarget('https://example.com/');

  it('rejects a name if any of its addresses is private', async () => {
    await expect(resolveTarget(target, resolvingTo('8.8.8.8', '127.0.0.1'))).rejects.toThrow(
      UnsafeTargetError,
    );
  });

  it('rejects a name with no addresses', async () => {
    await expect(resolveTarget(target, resolvingTo())).rejects.toThrow(UnsafeTargetError);
  });

  it('returns the addresses that passed', async () => {
    await expect(resolveTarget(target, resolvingTo('8.8.8.8'))).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
    ]);
  });
});
