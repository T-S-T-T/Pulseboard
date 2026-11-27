import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { probe } from '../../src/checks/probe.js';
import { publicPolicy, type TargetPolicy } from '../../src/security/ssrf.js';

let server: Server;
let port: number;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    if (request.url === '/slow') return;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/secret' }).end();
      return;
    }
    response.writeHead(request.url === '/broken' ? 500 : 200).end('body');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  hits = [];
});

/** Test-only policy that reaches the local server. Production uses publicPolicy. */
const local: TargetPolicy = {
  resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  isAllowedAddress: (address) => address === '127.0.0.1',
  isAllowedPort: () => true,
};
const check = (path: string, policy = local, host = 'service.example.test') =>
  probe({ url: `http://${host}:${port}${path}`, method: 'GET', timeoutMs: 1000 }, policy);

describe('probe', () => {
  it('reports a healthy service', async () => {
    // The name does not exist in DNS: only the pinned address can answer.
    await expect(check('/ok')).resolves.toMatchObject({ ok: true, statusCode: 200, error: null });
  });

  it('reports an error status', async () => {
    await expect(check('/broken')).resolves.toMatchObject({
      ok: false,
      statusCode: 500,
      error: 'HTTP 500',
    });
  });

  it('does not follow redirects', async () => {
    await expect(check('/redirect')).resolves.toMatchObject({ ok: true, statusCode: 302 });
    expect(hits).toEqual(['GET /redirect']);
  });

  it('gives up at the deadline', async () => {
    await expect(check('/slow')).resolves.toMatchObject({ ok: false, error: 'Timed out' });
  });

  it('applies the deadline to DNS too', async () => {
    const hanging = { ...local, resolve: () => new Promise<never>(() => {}) };
    await expect(check('/ok', hanging)).resolves.toMatchObject({ error: 'Timed out' });
  });

  it('reports a refused connection', async () => {
    const result = await probe(
      { url: 'http://service.example.test:1/', method: 'GET', timeoutMs: 1000 },
      local,
    );
    expect(result.error).toBe('Connection refused');
  });

  it('reports a DNS failure', async () => {
    const result = await probe({
      url: 'http://does-not-exist.invalid/',
      method: 'GET',
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ ok: false, error: 'DNS lookup failed' });
  });

  it('never connects to a private address under the production policy', async () => {
    const privateDns = { ...publicPolicy, isAllowedPort: () => true, resolve: local.resolve };
    const byName = await check('/ok', privateDns);
    const byAddress = await check('/ok', privateDns, '127.0.0.1');
    expect(byName.error).toMatch(/^Blocked:/);
    expect(byAddress.error).toMatch(/^Blocked:/);
    expect(hits).toEqual([]);
  });

  it('resolves only once, so a changed DNS answer has no effect', async () => {
    let lookups = 0;
    const rebinding: TargetPolicy = {
      ...local,
      resolve: async () => [{ address: ++lookups === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }],
    };
    await expect(check('/ok', rebinding)).resolves.toMatchObject({ ok: true });
    expect(lookups).toBe(1);
  });
});
