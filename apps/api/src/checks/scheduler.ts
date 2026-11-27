import type { Db } from '../db.js';
import { probe, type ProbeRequest, type ProbeResult } from './probe.js';

export interface SchedulerOptions {
  db: Db;
  probe?: (request: ProbeRequest) => Promise<ProbeResult>;
  pollMs?: number;
  concurrency?: number;
  retentionDays?: number;
  onError?: (error: unknown) => void;
}

interface DueService {
  id: string;
  url: string;
  method: 'GET' | 'HEAD';
  timeout_ms: number;
}

const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Runs checks inside the API process. Due services are claimed in the database,
 * so more than one instance can run safely. Phase 2 replaces this with workers.
 */
export function createScheduler({
  db,
  probe: check = probe,
  pollMs = 5_000,
  concurrency = 10,
  retentionDays = 30,
  onError = console.error,
}: SchedulerOptions) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = true;
  let lastPurge = 0;

  /** Claims and runs one batch. Returns the number of services claimed. */
  async function runBatch(): Promise<number> {
    const { rows } = await db.query<DueService>('SELECT * FROM claim_due_services($1)', [
      concurrency,
    ]);
    const outcomes = await Promise.allSettled(
      rows.map(async (service) => {
        const result = await check({
          url: service.url,
          method: service.method,
          timeoutMs: service.timeout_ms,
        });
        await db.query('SELECT record_check($1, $2, $3, $4, $5, $6)', [
          service.id,
          service.url,
          result.ok,
          result.statusCode,
          result.latencyMs,
          result.error,
        ]);
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') onError(outcome.reason);
    }
    return rows.length;
  }

  async function loop(): Promise<void> {
    try {
      // Keep going while there is a backlog.
      while (!stopped && (await runBatch()) === concurrency);
      if (Date.now() - lastPurge > PURGE_EVERY_MS) {
        await db.query('SELECT purge_expired($1)', [retentionDays]);
        lastPurge = Date.now();
      }
    } catch (error) {
      onError(error);
    }
    if (!stopped) schedule(pollMs);
  }

  function schedule(delay: number): void {
    timer = setTimeout(() => {
      running = loop();
    }, delay);
  }

  return {
    runBatch,
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
