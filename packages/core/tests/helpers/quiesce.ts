// Drain the app's fire-and-forget background work before a worker database is
// dropped.
//
// The app schedules sweeps that outlive the call that triggered them: a hook
// subscriber calls `dispatchTickForProject` without awaiting, `drainOutboxOnce`
// emits on the hooks bus which re-enters the pipeline, and pg-boss keeps its own
// timers. `cleanup()` used to end the pool and DROP the database while those were
// still running, so the sweep queried a database that no longer existed. vitest
// attributes that unhandled rejection to whichever FILE is running at the time,
// not the one that leaked it — the reason a docs-only commit could turn
// core-integration red.
//
// Everything here is best-effort and dynamically imported: a test file that never
// loaded the app must not pay for the module graph, and a file whose env cannot
// satisfy `db/client.js` must still reach its own teardown.

const MODULES = {
  dispatchTick: '../../src/jobs/dispatch-tick.js',
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

export interface QuiesceResult {
  /** Project ids whose dispatch sweep was still chained after the bounded drain. */
  stuckProjects: string[];
}

// cm:edge protocol -> packages/core/src/jobs/dispatch-tick.ts — ordering is load-bearing: stop the outbox worker FIRST so it cannot enqueue another sweep, then drain the sweeps already chained. Swapping these lets a drained tick be replaced by one the stopped worker had already queued.
export async function quiesceBackgroundWork(): Promise<QuiesceResult> {
  const outbox = await loadedOnly<typeof import('../../src/pipeline/outbox-worker.js')>(
    MODULES.outboxWorker,
  );
  if (outbox) await outbox.stopOutboxWorker().catch(() => {});

  const tick = await loadedOnly<typeof import('../../src/jobs/dispatch-tick.js')>(
    MODULES.dispatchTick,
  );
  const stuckProjects = tick ? await tick.quiesceDispatchTicks().catch(() => []) : [];

  const boss = await loadedOnly<typeof import('../../src/queue/boss.js')>(MODULES.boss);
  if (boss?.isBossStarted()) await boss.stopBoss().catch(() => {});

  // cm:guard closeDb goes LAST — the sweeps and pg-boss above run THROUGH this pool, so closing it first turns an orderly drain into the very "connection terminated" noise this helper exists to remove. It is also the pool nothing else closes: tests point DATABASE_URL at the worker database and import the app, and `client.end()` in db.ts only closes the HARNESS client. Measured before this call: 45 connections still open per integration run.
  const dbClient = await loadedOnly<typeof import('../../src/db/client.js')>(MODULES.dbClient);
  if (dbClient) await dbClient.closeDb().catch(() => {});

  return { stuckProjects };
}
