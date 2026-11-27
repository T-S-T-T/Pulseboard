'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Sends signed-out visitors to the sign-in page, then back again. */
export function useSignInRedirect() {
  const router = useRouter();
  return useCallback(
    (error: unknown): boolean => {
      if (!(error instanceof ApiError) || error.status !== 401) return false;
      const next = window.location.pathname + window.location.hash;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return true;
    },
    [router],
  );
}

/** Loads a resource and, if `refreshMs` is given, keeps it fresh. */
export function useResource<T>(path: string, refreshMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const redirect = useSignInRedirect();

  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (caught) {
      if (redirect(caught)) return;
      // Do not keep showing data the user can no longer access.
      if (caught instanceof ApiError && [403, 404].includes(caught.status)) setData(undefined);
      setError((caught as Error).message);
    }
  }, [path, redirect]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // Waits for each response before scheduling the next request.
    const tick = async () => {
      await reload();
      if (refreshMs && !cancelled) timer = setTimeout(tick, refreshMs);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reload, refreshMs]);

  return { data, error, reload };
}

/** Runs a change, tracking progress and showing any error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const redirect = useSignInRedirect();

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(undefined);
      try {
        await action();
      } catch (caught) {
        if (!redirect(caught)) setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [redirect],
  );

  return { busy, error, run };
}
