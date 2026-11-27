import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  parseTarget,
  publicPolicy,
  resolveTarget,
  UnsafeTargetError,
  type ResolvedAddress,
  type TargetPolicy,
} from '../security/ssrf.js';

export interface ProbeRequest {
  url: string;
  method: 'GET' | 'HEAD';
  timeoutMs: number;
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Makes one health check. Never throws: every failure becomes a result.
 *
 * Safety properties:
 *   * the connection is pinned to the addresses that passed the policy, so a DNS
 *     answer that changes after validation (DNS rebinding) has no effect;
 *   * redirects are reported, never followed;
 *   * the response body is discarded unread;
 *   * one deadline covers DNS, connect, TLS and response headers.
 */
export async function probe(
  request: ProbeRequest,
  policy: TargetPolicy = publicPolicy,
): Promise<ProbeResult> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(request.timeoutMs);
  try {
    const target = parseTarget(request.url, policy);
    const addresses = await abortable(resolveTarget(target, policy), deadline);
    const statusCode = await send(target.url, request.method, addresses, deadline);
    const ok = statusCode >= 200 && statusCode < 400;
    return {
      ok,
      statusCode,
      latencyMs: Math.round(performance.now() - started),
      error: ok ? null : `HTTP ${statusCode}`,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: deadline.aborted ? 'Timed out' : describe(error),
    };
  }
}

function send(
  url: URL,
  method: string,
  addresses: ResolvedAddress[],
  signal: AbortSignal,
): Promise<number> {
  // Hands Node the already validated addresses instead of resolving again.
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
    } else {
      const first = addresses[0]!;
      callback(null, first.address, first.family);
    }
  };
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method,
        lookup,
        signal,
        agent: false, // never reuse a connection that was validated for another check
        headers: { 'user-agent': 'Pulseboard/0.1 (uptime check)', accept: '*/*' },
      },
      (response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function describe(error: unknown): string {
  if (error instanceof UnsafeTargetError) return `Blocked: ${error.message}`;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  const known: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    ETIMEDOUT: 'Timed out',
  };
  if (known[code]) return known[code];
  if (/CERT|TLS|SSL/.test(code)) return `TLS error (${code})`;
  return 'Request failed';
}
