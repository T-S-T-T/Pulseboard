'use client';

import { useParams } from 'next/navigation';
import { ErrorMessage, History, StatusBadge } from '@/components/ui';
import type { StatusPage } from '@/lib/api';
import { useResource } from '@/lib/hooks';

function summary(services: StatusPage['services']): string {
  if (services.length === 0) return 'No services are listed yet';
  if (services.some((s) => s.ok === false)) return 'Some services are down';
  if (services.some((s) => s.ok === null)) return 'Waiting for the first checks';
  return 'All systems operational';
}

export default function PublicStatusPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data, error } = useResource<StatusPage>(`/status/${encodeURIComponent(slug)}`, 30_000);

  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-12">
      <ErrorMessage>{error}</ErrorMessage>
      {data && (
        <>
          <h1 className="text-3xl font-bold">{data.team} status</h1>
          <p role="status" className="card text-lg font-medium">
            {summary(data.services)}
          </p>
          <ul className="space-y-3">
            {data.services.map((service, i) => (
              <li key={i} className="card space-y-2" aria-label={service.name}>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">{service.name}</h2>
                  <StatusBadge ok={service.ok} />
                </div>
                <History checks={service.recent} />
                <p className="text-sm text-slate-500">
                  {service.uptime24h === null
                    ? 'No data from the last 24 hours'
                    : `${service.uptime24h}% of checks passed in the last 24 hours`}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
