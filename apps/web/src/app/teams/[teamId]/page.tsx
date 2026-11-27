'use client';

import { useParams } from 'next/navigation';
import { Incidents } from '@/components/incidents';
import { Services } from '@/components/services';
import { Members, StatusPageSettings } from '@/components/team-settings';
import { ErrorMessage, Shell } from '@/components/ui';
import type { Incident, Member, Service, Team, User } from '@/lib/api';
import { useResource } from '@/lib/hooks';

export default function TeamPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const base = `/teams/${encodeURIComponent(teamId)}`;
  const me = useResource<{ user: User }>('/auth/me');
  const team = useResource<{ team: Team; members: Member[] }>(base, 30_000);
  const services = useResource<{ services: Service[] }>(`${base}/services`, 5_000);
  const incidents = useResource<{ incidents: Incident[] }>(`${base}/incidents`, 5_000);

  return (
    <Shell>
      <ErrorMessage>{team.error ?? services.error ?? incidents.error}</ErrorMessage>
      {team.data && services.data && me.data ? (
        <>
          <h1 className="text-2xl font-bold">{team.data.team.name}</h1>
          <Services
            base={base}
            services={services.data.services}
            canEdit={team.data.team.role !== 'member'}
            reload={async () => {
              // Pausing, editing or deleting a service can end an incident.
              await Promise.all([services.reload(), incidents.reload()]);
            }}
          />
          {incidents.data && <Incidents incidents={incidents.data.incidents} />}
          <StatusPageSettings team={team.data.team} reload={team.reload} />
          <Members
            team={team.data.team}
            members={team.data.members}
            me={me.data.user}
            reload={team.reload}
          />
        </>
      ) : (
        !team.error && <p className="text-slate-500">Loading…</p>
      )}
    </Shell>
  );
}
