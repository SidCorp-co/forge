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

  // Closed for good rather than closed: work that outlived the file would otherwise open a pool
  // after this, which the teardown can only cut off under whatever statement it is sending.
  const dbClient = await loadedOnly<typeof import('../../src/db/client.js')>(MODULES.dbClient);
  if (dbClient) {
    closed = true;
    await dbClient.closeDbFor('when the test file gave its database back').catch(() => {});
  }

  return {};
}

let closed = false;

/** Let the app open its database again, for the next database this file is handed. */
export async function reopenAfterQuiesce(): Promise<void> {
  if (!closed) return;
  const dbClient = await loadedOnly<typeof import('../../src/db/client.js')>(MODULES.dbClient);
  dbClient?.reopenDb();
  closed = false;
}
