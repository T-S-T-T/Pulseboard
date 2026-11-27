import type { Incident } from '@/lib/api';

const time = (iso: string) => new Date(iso).toLocaleString();

export function Incidents({ incidents }: { incidents: Incident[] }) {
  return (
    <section className="space-y-3" aria-labelledby="incidents-heading">
      <h2 id="incidents-heading" className="text-lg font-semibold">
        Incidents
      </h2>
      {incidents.length === 0 ? (
        <p className="text-slate-600">
          No incidents. One opens when a service fails two checks in a row.
        </p>
      ) : (
        <ul className="card divide-y divide-slate-200 py-0">
          {incidents.map((incident) => (
            <li key={incident.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
              <div>
                <p className="font-semibold">{incident.serviceName}</p>
                <p className="text-slate-600">
                  Opened {time(incident.openedAt)}
                  {incident.error && ` · ${incident.error}`}
                </p>
              </div>
              {incident.resolvedAt ? (
                <p className="text-slate-600">Resolved {time(incident.resolvedAt)}</p>
              ) : (
                <p className="font-semibold text-red-800">Ongoing</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
