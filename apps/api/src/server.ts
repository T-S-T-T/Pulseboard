import { buildApp } from './app.js';
import { createScheduler } from './checks/scheduler.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db });
const scheduler = createScheduler({
  db,
  onError: (error) => app.log.error({ err: error }, 'Scheduler error'),
});

await app.listen({ host: config.HOST, port: config.PORT });
if (config.SCHEDULER_ENABLED) scheduler.start();

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    void (async () => {
      await app.close();
      await scheduler.stop();
      await db.end();
      process.exit(0);
    })();
  });
}
