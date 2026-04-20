import PgBoss from 'pg-boss';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Singleton pg-boss instance. Construction is side-effect-free; the connection
// pool and `pgboss.*` schema are created lazily on `start()`.
export const boss = new PgBoss(url);

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await boss.start();
  started = true;
}

export async function stopBoss(): Promise<void> {
  if (!started) return;
  await boss.stop({ graceful: true });
  started = false;
}

export function isBossStarted(): boolean {
  return started;
}

export type Boss = typeof boss;
