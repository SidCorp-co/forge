// Drain the app's fire-and-forget background work before a worker database is
// dropped.
//
// The app schedules work that outlives the call that triggered them:
// `drainOutboxOnce` emits on the hooks bus which re-enters the pipeline, and
// pg-boss keeps its own timers. `cleanup()` used to end the pool and DROP the database while those were
// still running, so the sweep queried a database that no longer existed. vitest
// attributes that unhandled rejection to whichever FILE is running at the time,
// not the one that leaked it — the reason a docs-only commit could turn
// core-integration red.
//
// Everything here is best-effort and dynamically imported: a test file that never
// loaded the app must not pay for the module graph, and a file whose env cannot
// satisfy `db/client.js` must still reach its own teardown.

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

// cm:why the drain reports nothing now that no pass re-chains itself: pg-boss and the outbox worker are stopped outright, so "it returned" IS the whole result. Kept as a named type rather than `void` because `quiesceOrReport` awaits it and a future pass with something to report has somewhere to put it.
export type QuiesceResult = Record<string, never>;

// cm:guard stop the outbox worker BEFORE pg-boss — it emits on the hooks bus, which re-enters the pipeline, so a worker still running while the queue goes down enqueues against a database the harness is about to drop.
export async function quiesceBackgroundWork(): Promise<QuiesceResult> {
  const outbox = await loadedOnly<typeof import('../../src/pipeline/outbox-worker.js')>(
    MODULES.outboxWorker,
  );
  if (outbox) await outbox.stopOutboxWorker().catch(() => {});

  const boss = await loadedOnly<typeof import('../../src/queue/boss.js')>(MODULES.boss);
  if (boss?.isBossStarted()) await boss.stopBoss().catch(() => {});

  // cm:guard closeDb goes LAST — the sweeps and pg-boss above run THROUGH this pool, so closing it first turns an orderly drain into the very "connection terminated" noise this helper exists to remove. It is also the pool nothing else closes: tests point DATABASE_URL at the worker database and import the app, and `client.end()` in db.ts only closes the HARNESS client. Measured before this call: 45 connections still open per integration run.
  const dbClient = await loadedOnly<typeof import('../../src/db/client.js')>(MODULES.dbClient);
  if (dbClient) await dbClient.closeDb().catch(() => {});

  return {};
}
