export type Role = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  statusPageEnabled: boolean;
  role: Role;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

export interface Check {
  ok: boolean;
  checkedAt: string;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
}

export interface Service {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'HEAD';
  intervalSeconds: number;
  timeoutMs: number;
  enabled: boolean;
  isPublic: boolean;
  lastOk: boolean | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  recentChecks: Check[];
}

export interface StatusPage {
  team: string;
  services: {
    name: string;
    ok: boolean | null;
    lastCheckedAt: string | null;
    uptime24h: number | null;
    recent: Check[];
  }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = void>(
  path: string,
  options: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, data?.error ?? 'Could not reach the server');
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}
