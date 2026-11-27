'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Check } from '@/lib/api';
import { api } from '@/lib/api';

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link href="/dashboard" className="font-semibold">
            Pulseboard
          </Link>
          <button
            className="btn-quiet"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' });
              router.replace('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">{children}</main>
    </>
  );
}

export function ErrorMessage({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </p>
  );
}

/** State is always written out, so it never depends on colour alone. */
export function StatusBadge({ ok }: { ok: boolean | null }) {
  const [text, style] =
    ok === null
      ? ['Pending', 'bg-slate-100 text-slate-700']
      : ok
        ? ['Up', 'bg-emerald-100 text-emerald-800']
        : ['Down', 'bg-red-100 text-red-800'];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>{text}</span>
  );
}

/** Recent checks, oldest on the left. Failures are also shorter than successes. */
export function History({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return <p className="text-xs text-slate-500">No checks yet</p>;
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <div
      role="img"
      aria-label={`Last ${checks.length} checks: ${failed} failed`}
      className="flex h-6 items-end gap-0.5"
    >
      {checks.map((check, i) => (
        <span
          key={`${check.checkedAt}-${i}`}
          title={`${new Date(check.checkedAt).toLocaleString()}: ${check.ok ? 'up' : (check.error ?? 'down')}`}
          className={`w-1.5 rounded-sm ${check.ok ? 'h-6 bg-emerald-500' : 'h-3 bg-red-500'}`}
        />
      ))}
    </div>
  );
}
