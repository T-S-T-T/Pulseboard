'use client';

import { useRouter } from 'next/navigation';
import { ErrorMessage, Shell } from '@/components/ui';
import { api, type User } from '@/lib/api';
import { useAction, useResource } from '@/lib/hooks';

export default function InvitePage() {
  const router = useRouter();
  // Redirects to sign-in first if needed, keeping the token after "#".
  const me = useResource<{ user: User }>('/auth/me');
  const { busy, error, run } = useAction();

  return (
    <Shell>
      <h1 className="text-2xl font-bold">Join a team</h1>
      <ErrorMessage>{error ?? me.error}</ErrorMessage>
      {me.data && (
        <>
          <p className="text-slate-600">You are signed in as {me.data.user.email}.</p>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const token = window.location.hash.slice(1);
                if (!token) throw new Error('This invite link is incomplete');
                const { teamId } = await api<{ teamId: string }>('/invites/accept', {
                  method: 'POST',
                  body: { token },
                });
                router.replace(`/teams/${teamId}`);
              })
            }
          >
            Accept invite
          </button>
        </>
      )}
    </Shell>
  );
}
