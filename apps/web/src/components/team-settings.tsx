'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, type Member, type Role, type Team, type User } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { ErrorMessage } from './ui';

export function StatusPageSettings({ team, reload }: { team: Team; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const canEdit = team.role !== 'member';
  return (
    <section className="card space-y-2">
      <h2 className="text-lg font-semibold">Public status page</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={team.statusPageEnabled}
          disabled={!canEdit || busy}
          onChange={(event) => {
            const statusPageEnabled = event.target.checked;
            void run(async () => {
              await api(`/teams/${team.id}`, { method: 'PATCH', body: { statusPageEnabled } });
              await reload();
            });
          }}
        />
        Publish the status page
      </label>
      {team.statusPageEnabled && (
        <Link className="text-sm text-indigo-700 underline" href={`/status/${team.slug}`}>
          View status page
        </Link>
      )}
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}

export function Members({
  team,
  members,
  me,
  reload,
}: {
  team: Team;
  members: Member[];
  me: User;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [inviteUrl, setInviteUrl] = useState<string>();
  const isOwner = team.role === 'owner';
  const base = `/teams/${team.id}`;

  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">Members</h2>
      <ul className="divide-y divide-slate-100">
        {members.map((member) => {
          const isMe = member.userId === me.id;
          return (
            <li
              key={member.userId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="text-sm">
                <span className="font-medium">{member.name}</span>{' '}
                <span className="text-slate-500">{member.email}</span>
              </span>
              <span className="flex items-center gap-2">
                {isOwner ? (
                  <select
                    className="input w-auto"
                    aria-label={`Role of ${member.name}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => {
                      const role = event.target.value as Role;
                      void run(async () => {
                        await api(`${base}/members/${member.userId}`, {
                          method: 'PATCH',
                          body: { role },
                        });
                        await reload();
                      });
                    }}
                  >
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                ) : (
                  <span className="text-sm text-slate-500">{member.role}</span>
                )}
                {(isOwner || isMe) && (
                  <button
                    className="btn-quiet"
                    disabled={busy}
                    onClick={() => {
                      const question = isMe ? `Leave ${team.name}?` : `Remove ${member.name}?`;
                      if (!window.confirm(question)) return;
                      void run(async () => {
                        await api(`${base}/members/${member.userId}`, { method: 'DELETE' });
                        if (isMe) router.replace('/dashboard');
                        else await reload();
                      });
                    }}
                  >
                    {isMe ? 'Leave' : 'Remove'}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {team.role !== 'member' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = Object.fromEntries(new FormData(event.currentTarget));
            void run(async () => {
              const invite = await api<{ url: string }>(`${base}/invites`, {
                method: 'POST',
                body,
              });
              setInviteUrl(invite.url);
            });
          }}
        >
          <div>
            <label className="label" htmlFor="invite-role">
              Invite as
            </label>
            <select id="invite-role" name="role" className="input">
              <option value="member">member</option>
              {isOwner && <option value="admin">admin</option>}
            </select>
          </div>
          <button className="btn" disabled={busy}>
            Create invite link
          </button>
        </form>
      )}
      {inviteUrl && (
        <div>
          <label className="label" htmlFor="invite-url">
            Send this link to one person. It works once and expires in 7 days.
          </label>
          <input
            id="invite-url"
            className="input"
            readOnly
            value={inviteUrl}
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}
      <ErrorMessage>{error}</ErrorMessage>
    </section>
  );
}
