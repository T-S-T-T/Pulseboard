'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorMessage } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction, useResource } from '@/lib/hooks';
import { safeNextPath } from '@/lib/redirect';

const SSO_ERRORS: Record<string, string> = {
  email_in_use: 'An account with this email already exists. Sign in with your password.',
  email_unverified: 'Your provider has not verified your email address.',
  sso_failed: 'Single sign-on failed. Please try again.',
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [register, setRegister] = useState(params.get('mode') === 'register');
  const { busy, error, run } = useAction();
  const providers = useResource<{ oidc: { name: string } | null }>('/auth/providers');
  const ssoError = SSO_ERRORS[params.get('error') ?? ''];

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-6 text-2xl font-bold">
        {register ? 'Create your account' : 'Sign in to Pulseboard'}
      </h1>
      <form
        className="card space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = Object.fromEntries(new FormData(event.currentTarget));
          void run(async () => {
            await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body });
            router.replace(safeNextPath(params.get('next')));
          });
        }}
      >
        <ErrorMessage>{error ?? ssoError}</ErrorMessage>
        {register && (
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input
              id="name"
              name="name"
              className="input"
              autoComplete="name"
              required
              maxLength={80}
            />
          </div>
        )}
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            autoComplete="email"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={register ? 10 : undefined}
            maxLength={128}
          />
          {register && <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>}
        </div>
        <button className="btn w-full" disabled={busy}>
          {register ? 'Create account' : 'Sign in'}
        </button>
        {providers.data?.oidc && (
          // A full page load, because the API answers with a redirect.
          <a className="btn-quiet block text-center" href="/api/auth/oidc/start">
            Continue with {providers.data.oidc.name}
          </a>
        )}
      </form>
      <button
        className="mt-4 cursor-pointer text-sm text-indigo-700 underline"
        onClick={() => setRegister(!register)}
      >
        {register ? 'I already have an account' : 'Create a new account'}
      </button>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
