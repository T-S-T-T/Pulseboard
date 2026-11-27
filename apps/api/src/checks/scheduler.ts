import type { Db } from '../db.js';
import { probe, type ProbeRequest, type ProbeResult } from './probe.js';

export interface SchedulerOptions {
  db: Db;
  probe?: (request: ProbeRequest) => Promise<ProbeResult>;
  pollMs?: number;
  concurrency?: number;
  retentionDays?: number;
  /** How long a job may go unreported before it is handed out again. */
  leaseSeconds?: number;
  onError?: (error: unknown) => void;
}

interface Job {
  job_id: string;
  url: string;
  method: 'GET' | 'HEAD';
  timeout_ms: number;
}

const PURGE_EVERY_MS = 60 * 60 * 1000;
const SCHEDULE_LIMIT = 100;

/**
 * Runs checks inside the API process. Due services become jobs in the database
 * and each job is leased to one instance at a time, so several instances can run
 * safely and a job interrupted by a crash is retried. Separate workers will
 * replace the in-process probe later in phase 2.
 */
export function createScheduler({
  db,
  probe: check = probe,
  pollMs = 5_000,
  concurrency = 10,
  retentionDays = 30,
  // Comfortably longer than the longest check timeout (15 seconds).
  leaseSeconds = 60,
  onError = console.error,
}: SchedulerOptions) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let stopped = true;
  let lastPurge = 0;

  /** Leases and runs one batch. Returns the number of jobs leased. */
  async function runBatch(): Promise<number> {
    await db.query('SELECT schedule_check_jobs($1)', [SCHEDULE_LIMIT]);
    const { rows } = await db.query<Job>('SELECT * FROM lease_check_jobs($1, $2)', [
      concurrency,
      leaseSeconds,
    ]);
    const outcomes = await Promise.allSettled(
      rows.map(async (job) => {
        const result = await check({
          url: job.url,
          method: job.method,
          timeoutMs: job.timeout_ms,
        });
        await db.query('SELECT complete_check_job($1, $2, $3, $4, $5)', [
          job.job_id,
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
