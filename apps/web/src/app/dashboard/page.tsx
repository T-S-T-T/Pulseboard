'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorMessage, Shell } from '@/components/ui';
import { api, type Team } from '@/lib/api';
import { useAction, useResource } from '@/lib/hooks';

export default function Dashboard() {
  const router = useRouter();
  const { data, error } = useResource<{ teams: Team[] }>('/teams');
  const create = useAction();

  return (
    <Shell>
      <h1 className="text-2xl font-bold">Your teams</h1>
      <ErrorMessage>{error}</ErrorMessage>
      {data?.teams.length === 0 && (
        <p className="text-slate-600">Create a team to start monitoring your services.</p>
      )}
      <ul className="space-y-2">
        {data?.teams.map((team) => (
          <li key={team.id}>
            <Link
              href={`/teams/${team.id}`}
              className="card flex justify-between hover:border-indigo-400"
            >
              <span className="font-medium">{team.name}</span>
              <span className="text-sm text-slate-500">{team.role}</span>
            </Link>
          </li>
        ))}
      </ul>
      <form
        className="card space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const body = Object.fromEntries(new FormData(event.currentTarget));
          void create.run(async () => {
            const { team } = await api<{ team: Team }>('/teams', { method: 'POST', body });
            router.push(`/teams/${team.id}`);
          });
        }}
      >
        <label className="label" htmlFor="team-name">
          New team name
        </label>
        <div className="flex gap-2">
          <input id="team-name" name="name" className="input" required maxLength={80} />
          <button className="btn shrink-0" disabled={create.busy}>
            Create team
          </button>
        </div>
        <ErrorMessage>{create.error}</ErrorMessage>
      </form>
    </Shell>
  );
}
