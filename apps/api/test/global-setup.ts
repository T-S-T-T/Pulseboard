import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

/**
 * Gives the integration tests a throwaway database. Uses TEST_DATABASE_URL (a
 * superuser connection) when set; otherwise starts PostgreSQL with Testcontainers.
 */
export default async function setup(project: TestProject) {
  const envFile = new URL('../../../.env', import.meta.url);
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopContainer: (() => Promise<unknown>) | undefined;
  if (!adminUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  const name = `pulseboard_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);

  const owner = new URL(adminUrl);
  owner.pathname = `/${name}`;
  await migrate({ ownerUrl: owner.href });

  // Switching role (rather than setting a password) leaves a developer's local
  // pulseboard_app credentials untouched while still enforcing RLS.
  const app = new URL(owner);
  app.searchParams.set('options', '-c role=pulseboard_app');

  project.provide('ownerUrl', owner.href);
  project.provide('appUrl', app.href);

  return async () => {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await stopContainer?.();
  };
}
