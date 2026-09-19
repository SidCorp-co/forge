const MODULES = {
  outboxWorker: '../../src/pipeline/outbox-worker.js',
  boss: '../../src/queue/boss.js',
  dbClient: '../../src/db/client.js',
} as const;

async function loadedOnly<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

export type QuiesceResult = Record<string, never>;

export async function quiesceBackgroundWork(): Promise<QuiesceResult> {
  const outbox = await loadedOnly<typeof import('../../src/pipeline/outbox-worker.js')>(
    MODULES.outboxWorker,
  );
  if (outbox) await outbox.stopOutboxWorker().catch(() => {});

  const boss = await loadedOnly<typeof import('../../src/queue/boss.js')>(MODULES.boss);
  if (boss?.isBossStarted()) await boss.stopBoss().catch(() => {});

  const dbClient = await loadedOnly<typeof import('../../src/db/client.js')>(MODULES.dbClient);
  if (dbClient) await dbClient.closeDb().catch(() => {});

  return {};
}
