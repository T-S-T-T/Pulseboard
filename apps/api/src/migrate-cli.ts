import { migrate } from './migrate.js';

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATION_DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const applied = await migrate({ ownerUrl, appPassword: process.env.APP_DB_PASSWORD || undefined });
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is already up to date.');
