'use client';

import { useState } from 'react';
import { api, type Service } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { ErrorMessage, History, StatusBadge } from './ui';

function ServiceForm({
  service,
  onSubmit,
  onCancel,
  busy,
}: {
  service?: Service;
  onSubmit: (body: object, form: HTMLFormElement) => void;
  onCancel?: () => void;
  busy: boolean;
}) {
  const id = service?.id ?? 'new';
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit(
          {
            name: form.get('name'),
            url: form.get('url'),
            method: form.get('method'),
            intervalSeconds: Number(form.get('intervalSeconds')),
            timeoutMs: Number(form.get('timeoutSeconds')) * 1000,
            isPublic: form.get('isPublic') === 'on',
          },
          event.currentTarget,
        );
      }}
    >
      <div>
        <label className="label" htmlFor={`${id}-name`}>
          Service name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          className="input"
          required
          maxLength={80}
          defaultValue={service?.name}
        />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-url`}>
          URL to check
        </label>
        <input
          id={`${id}-url`}
          name="url"
          type="url"
          className="input"
          required
          maxLength={2000}
          placeholder="https://example.com/health"
          defaultValue={service?.url}
        />
      </div>
      <div className="grid grid-cols-3 gap-3 sm:col-span-2">
        <div>
          <label className="label" htmlFor={`${id}-method`}>
            Method
          </label>
          <select
            id={`${id}-method`}
            name="method"
            className="input"
            defaultValue={service?.method ?? 'GET'}
          >
            <option>GET</option>
            <option>HEAD</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-interval`}>
            Every (seconds)
          </label>
          <input
            id={`${id}-interval`}
            name="intervalSeconds"
            type="number"
            className="input"
            min={60}
            max={3600}
            required
            defaultValue={service?.intervalSeconds ?? 60}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-timeout`}>
            Timeout (seconds)
          </label>
          <input
            id={`${id}-timeout`}
            name="timeoutSeconds"
            type="number"
            className="input"
            min={1}
            max={15}
            step="any"
            required
            defaultValue={(service?.timeoutMs ?? 5000) / 1000}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="isPublic" defaultChecked={service?.isPublic} />
        Show on the public status page
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn" disabled={busy}>
          {service ? 'Save changes' : 'Add service'}
        </button>
        {onCancel && (
          <button type="button" className="btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ServiceCard({
  base,
  service,
  canEdit,
  reload,
}: {
  base: string;
  service: Service;
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const path = `${base}/services/${service.id}`;
  const change = (method: 'PATCH' | 'DELETE', body?: object) =>
    run(async () => {
      await api(path, { method, body });
      setEditing(false);
      await reload();
    });

  return (
    <li className="card space-y-3" aria-label={service.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{service.name}</h3>
          <p className="truncate text-sm text-slate-500">{service.url}</p>
        </div>
        {service.enabled ? (
          <StatusBadge ok={service.lastOk} />
        ) : (
          <span className="text-xs font-semibold text-slate-500">Paused</span>
        )}
      </div>
      <History checks={service.recentChecks} />
      <p className="text-sm text-slate-600">
        {service.lastCheckedAt
          ? `Last checked ${new Date(service.lastCheckedAt).toLocaleTimeString()}`
          : 'Waiting for the first check'}
        {service.lastLatencyMs !== null && ` · ${service.lastLatencyMs} ms`}
        {service.lastError && ` · ${service.lastError}`}
      </p>
      <ErrorMessage>{error}</ErrorMessage>
      {canEdit && !editing && (
        <div className="flex gap-2">
          <button className="btn-quiet" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="btn-quiet"
            disabled={busy}
            onClick={() => change('PATCH', { enabled: !service.enabled })}
          >
            {service.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            className="btn-quiet"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${service.name} and its history?`)) void change('DELETE');
            }}
          >
            Delete
          </button>
        </div>
      )}
      {editing && (
        <ServiceForm
          service={service}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => void change('PATCH', body)}
        />
      )}
    </li>
  );
}

export function Services({
  base,
  services,
  canEdit,
  reload,
}: {
  base: string;
  services: Service[];
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const add = useAction();
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Services</h2>
      {services.length === 0 && <p className="text-slate-600">No services yet.</p>}
      <ul className="space-y-3">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            base={base}
            service={service}
            canEdit={canEdit}
            reload={reload}
          />
        ))}
      </ul>
      {canEdit && (
        <div className="card space-y-3">
          <h3 className="font-semibold">Add a service</h3>
          <ErrorMessage>{add.error}</ErrorMessage>
          <ServiceForm
            busy={add.busy}
            onSubmit={(body, form) =>
              void add.run(async () => {
                await api(`${base}/services`, { method: 'POST', body });
                form.reset();
                await reload();
              })
            }
          />
        </div>
      )}
    </section>
  );
}
