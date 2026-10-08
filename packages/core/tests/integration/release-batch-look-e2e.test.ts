/**
 * ISS-1282 — the agent says when to look and Forge takes the reading, so a release is closed by a
 * recorded reading and not by a timer, against real Postgres and real probe servers.
 *
 * What is planted here is what the polling window could not represent: a deploy that lands after
 * the agent first asks (green with no second finish), a deploy that never lands (the run stays
 * open and says so), a healthy site still serving the old build, and an agent that never looks.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const BEFORE = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let job: typeof import('../../src/release-batch/finish-job.js');
let service: typeof import('../../src/release-batch/service.js');
let errors: typeof import('../../src/release-batch/errors.js');
let stateModule: typeof import('../../src/release-batch/state.js');

/** Two probe servers, one per deploy binding, each answering the commit it is told to. */
const sites = {
  a: { serving: BEFORE, server: null as unknown as Server, url: '' },
  b: { serving: BEFORE, server: null as unknown as Server, url: '' },
};

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

async function listen(site: typeof sites.a): Promise<void> {
  site.server = createServer((_req, res) => res.end(site.serving));
  await new Promise<void>((done) => site.server.listen(0, '127.0.0.1', done));
  site.url = `http://127.0.0.1:${(site.server.address() as AddressInfo).port}/version`;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  await listen(sites.a);
  await listen(sites.b);
  job = await import('../../src/release-batch/finish-job.js');
  service = await import('../../src/release-batch/service.js');
  errors = await import('../../src/release-batch/errors.js');
  stateModule = await import('../../src/release-batch/state.js');
}, 120_000);

afterAll(async () => {
  for (const site of [sites.a, sites.b]) {
    site.server?.closeAllConnections();
    await new Promise<void>((done) => site.server?.close(() => done()));
  }
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  sites.a.serving = BEFORE;
  sites.b.serving = BEFORE;
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await fx.seedReleaseRunner();
});

/** One probed binding per site named, each declaring the stableReads given (the default is two). */
async function declare(which: Array<'a' | 'b'>, stableReads?: number): Promise<void> {
  for (const name of which) {
    await fx.declareProduction({
      verify: {
        probes: [{ url: sites[name].url }],
        ...(stableReads === undefined ? {} : { stableReads }),
      },
    });
  }
}

/** A batch of `n` issues opened while every site serves BEFORE, with nobody having looked. */
async function batch(n = 1) {
  const issueIds: string[] = [];
  for (let i = 0; i < n; i += 1) issueIds.push(await fx.insertIssue());
  const { runId } = await fx.claim(issueIds, { deploy: false, look: false });
  return { runId, issueIds };
}

const actor = () => ({ type: 'user' as const, id: ownerId });

async function refusalOf(
  call: Promise<unknown>,
): Promise<Error & { reason?: string; live?: string | null }> {
  try {
    await call;
  } catch (err) {
    return err as Error & { live?: string | null };
  }
  throw new Error('the call was not refused');
}

async function storedFinish(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await harness.db.execute(sql`
    SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
  `);
  return (rows[0]?.finish as Record<string, unknown> | null) ?? null;
}

async function readingCount(runId: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM release_readings WHERE run_id = ${runId}
  `);
  return Number(rows[0]?.n ?? 0);
}

async function markedComments(issueId: string, text: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId} AND body LIKE ${`%${text}%`}
  `);
  return Number(rows[0]?.n ?? 0);
}

describe('the late deploy: the site is still old when the agent first looks', () => {
  it('is refused while the readings show the old build, and one finish closes it once they show the new', async () => {
    await declare(['a']);
    const { runId, issueIds } = await batch();

    // The agent looks too early: the site is healthy and serving what it served before.
    await fx.look(runId);
    const early = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));
    expect(early).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(early.live).toBe(BEFORE);
    expect(early.reason).toContain(`the live build is unchanged (${BEFORE})`);
    expect((await fx.stored(issueIds[0] as string)).status).toBe('releasing');

    // The deploy lands. Nothing finishes in the meantime: no attempt was ever recorded to fail.
    sites.a.serving = PUSHED;
    const one = await fx.look(runId);
    expect(one.judgement).toMatchObject({ closable: false });
    const two = await fx.look(runId);
    expect(two.judgement).toMatchObject({ closable: true, moved: true });

    const done = await service.finishReleaseBatch(runId, actor(), { commit: PUSHED });

    expect(done.closed).toEqual(issueIds);
    expect(await storedFinish(runId)).toBeNull();
    expect((await fx.stored(issueIds[0] as string)).status).toBe('closed');
    expect(await fx.runStatus(runId)).toBe('completed');
  }, 40_000);

  it('does not believe one reading of the new build where the binding asks for two', async () => {
    await declare(['a']);
    const { runId } = await batch();
    sites.a.serving = PUSHED;
    await fx.look(runId);

    const refused = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));

    expect(refused.reason).toContain('1 of the 2 consecutive readings');
  });
});

describe('the deploy that never lands: the run stays open, and says so', () => {
  it('refuses every finish, keeps the roster releasing, and lists the readings on the state', async () => {
    await declare(['a']);
    const { runId, issueIds } = await batch(2);

    await fx.look(runId, { times: 3 });
    const refused = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));
    const again = await refusalOf(service.finishReleaseBatch(runId, actor(), {}));

    expect(refused.reason).toContain(`the live build is unchanged (${BEFORE})`);
    expect(again.reason).toContain(`the live build is unchanged (${BEFORE})`);
    expect(await fx.runStatus(runId)).toBe('running');
    for (const id of issueIds) {
      expect(await fx.stored(id)).toMatchObject({ status: 'releasing', claim: runId });
    }
    const state = await stateModule.readReleaseRunState(runId);
    expect(state?.readings.total).toBe(3);
    expect(state?.readings.latest.map((r) => r.bindings[0]?.identity)).toEqual([
      BEFORE,
      BEFORE,
      BEFORE,
    ]);
    expect(await storedFinish(runId)).toBeNull();
  }, 40_000);

  it('never closes on a site that answers healthy and serves the old build, whatever the commit named', async () => {
    await declare(['a'], 1);
    const { runId, issueIds } = await batch();
    await fx.look(runId, { times: 5 });

    const named = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));
    const claimless = await refusalOf(service.finishReleaseBatch(runId, actor(), {}));

    expect(named).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(claimless).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect((await fx.stored(issueIds[0] as string)).status).toBe('releasing');
  });

  it('refuses a finish from an agent that never looked, naming that no reading is recorded', async () => {
    await declare(['a'], 1);
    sites.a.serving = PUSHED;
    const { runId, issueIds } = await batch();

    const refused = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));

    expect(refused).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(refused.reason).toContain('no reading');
    expect(refused.reason).toContain('`look`');
    expect(await readingCount(runId)).toBe(0);
    expect((await fx.stored(issueIds[0] as string)).status).toBe('releasing');
  });

  it('refuses a reading older than the age evidence may have, and takes a fresh one', async () => {
    await declare(['a'], 1);
    const { runId } = await batch();
    sites.a.serving = PUSHED;
    await fx.look(runId);
    await harness.db.execute(sql`
      UPDATE release_readings SET taken_at = now() - interval '16 minutes' WHERE run_id = ${runId}
    `);

    const stale = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));
    expect(stale.reason).toMatch(/16 minutes old/);

    await fx.look(runId);
    const done = await service.finishReleaseBatch(runId, actor(), { commit: PUSHED });
    expect(done.closed).toHaveLength(1);
  });
});

describe('each live binding is read', () => {
  it('opens a batch on a project with two deploy bindings, recording what each served before', async () => {
    await declare(['a', 'b']);

    const { runId } = await batch();

    const rows = await harness.db.execute(sql`
      SELECT r.key AS binding, r.value AS commit
      FROM pipeline_runs p, jsonb_each_text(p.metadata -> 'commitBeforeBy') r
      WHERE p.id = ${runId}
    `);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.commit)).toEqual([BEFORE, BEFORE]);
  });

  it('closes only when every binding confirms, and names the binding that does not', async () => {
    await declare(['a', 'b'], 1);
    const { runId, issueIds } = await batch();

    sites.a.serving = PUSHED;
    const first = await fx.look(runId);
    expect(first.reading.bindings.map((b) => b.identity)).toEqual([PUSHED, BEFORE]);
    const refused = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));
    expect(refused.reason).toMatch(/^coolify[^:]*: the live build is unchanged/);
    expect((await fx.stored(issueIds[0] as string)).status).toBe('releasing');

    sites.b.serving = PUSHED;
    await fx.look(runId);
    const done = await service.finishReleaseBatch(runId, actor(), { commit: PUSHED });

    expect(done.closed).toEqual(issueIds);
    expect(await readingCount(runId)).toBe(2);
  }, 40_000);

  it('keeps a binding whose newest reading went back to the old build from closing on its older ones', async () => {
    await declare(['a', 'b'], 1);
    const { runId } = await batch();
    sites.a.serving = PUSHED;
    sites.b.serving = PUSHED;
    await fx.look(runId);
    sites.b.serving = BEFORE;
    await fx.look(runId);

    const refused = await refusalOf(service.finishReleaseBatch(runId, actor(), { commit: PUSHED }));

    expect(refused).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(refused.reason).toContain('the live build is unchanged');
  });

  it('names a live binding with no probe as unread, on each closed issue', async () => {
    await declare(['a'], 1);
    await fx.declareProduction({ verify: null });
    const { runId, issueIds } = await batch(2);
    sites.a.serving = PUSHED;
    const looked = await fx.look(runId);
    expect(looked.reading.unread).toHaveLength(1);

    const done = await service.finishReleaseBatch(runId, actor(), { commit: PUSHED });

    expect(done.closed).toEqual(issueIds);
    for (const id of issueIds) {
      expect(await markedComments(id, 'verified at only some of its deploy bindings')).toBe(1);
    }
  }, 40_000);
});

describe('what a finish records when it closes on readings', () => {
  it('stamps the readings it rested on on the finish record, and never on a refused one', async () => {
    await declare(['a']);
    const { runId } = await batch();
    sites.a.serving = PUSHED;
    await fx.look(runId, { times: 3 });
    const ids = (
      await harness.db.execute(sql`
        SELECT id FROM release_readings WHERE run_id = ${runId} ORDER BY taken_at, id
      `)
    ).map((r) => String(r.id));

    await job.acceptReleaseBatchFinish(runId, actor(), { commit: PUSHED }, async () => {});
    await job.runReleaseBatchFinish(runId);

    const finish = await storedFinish(runId);
    expect(finish).toMatchObject({ state: 'finished' });
    // The two newest consecutive readings are what stableReads (two) rests a close on.
    expect(finish?.evidence).toEqual(ids.slice(-2));
  }, 40_000);

  it('ends a worker whose readings turned red after the door accepted, closing nothing', async () => {
    await declare(['a'], 1);
    const { runId, issueIds } = await batch();
    sites.a.serving = PUSHED;
    await fx.look(runId);
    await job.acceptReleaseBatchFinish(runId, actor(), { commit: PUSHED }, async () => {});
    sites.a.serving = BEFORE;
    await fx.look(runId);

    await job.runReleaseBatchFinish(runId);

    expect(await storedFinish(runId)).toMatchObject({
      state: 'failed',
      refusal: { code: 'RELEASE_NOT_VERIFIED' },
      evidence: null,
    });
    expect((await fx.stored(issueIds[0] as string)).status).toBe('releasing');
  });
});

describe('a look is refused by name where it can read nothing', () => {
  it('refuses a look on a project whose live bindings declare no probe', async () => {
    await fx.declareProduction({ verify: null });
    const { runId } = await batch();

    const refused = await refusalOf(fx.look(runId));

    expect(refused).toBeInstanceOf(errors.ReleaseNothingToReadError);
    expect(await readingCount(runId)).toBe(0);
  });

  it('refuses a look at an aborted batch, and stores no reading', async () => {
    await declare(['a']);
    const { runId } = await batch();
    await service.abortReleaseBatch(runId, 'a person stopped it', ownerId);

    const refused = await refusalOf(fx.look(runId));

    expect(refused).toBeInstanceOf(errors.ReleaseBatchAbortedError);
    expect(await readingCount(runId)).toBe(0);
  });

  it('refuses a look at a run that has ended', async () => {
    await declare(['a'], 1);
    const { runId } = await batch();
    sites.a.serving = PUSHED;
    await fx.look(runId);
    await service.finishReleaseBatch(runId, actor(), { commit: PUSHED });

    const refused = await refusalOf(fx.look(runId));

    expect(refused).toBeInstanceOf(errors.ReleaseRunClosedError);
    expect(await readingCount(runId)).toBe(1);
  });

  it('refuses a commit that is not a whole sha, and stores no reading', async () => {
    await declare(['a']);
    const { runId } = await batch();

    const refused = await refusalOf(fx.look(runId, { commit: 'abc1234' }));

    expect(refused).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(await readingCount(runId)).toBe(0);
  });
});

describe('the readings belong to their run', () => {
  it('go with the run they were taken for', async () => {
    await declare(['a']);
    const kept = await batch();
    await fx.look(kept.runId, { times: 2 });
    expect(await readingCount(kept.runId)).toBe(2);

    await harness.db.execute(sql`UPDATE issues SET release_batch_run_id = NULL`);
    await harness.db.execute(sql`DELETE FROM jobs WHERE pipeline_run_id = ${kept.runId}`);
    await harness.db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${kept.runId}`);

    expect(await readingCount(kept.runId)).toBe(0);
  });
});

describe('a release recorded after the fact reads every binding once, at the moment of the record', () => {
  const record = (issueIds: string[]) =>
    import('../../src/release-batch/recorded.js').then((m) =>
      m.recordPerformedRelease({
        projectId,
        userId: ownerId,
        issueIds,
        commit: PUSHED,
        account: 'Promoted by hand; production serves this commit.',
      }),
    );

  it('refuses it naming the binding that is not serving the commit, and takes no claim', async () => {
    await declare(['a', 'b']);
    const issueId = await fx.insertIssue();
    sites.a.serving = PUSHED;

    const refused = await refusalOf(record([issueId]));

    expect(refused).toBeInstanceOf(errors.ReleaseNotVerifiedError);
    expect(refused.reason).toMatch(/^coolify[^:]*: /);
    expect((await fx.stored(issueId)).claim).toBeNull();
  });

  it('records it where both bindings serve the commit', async () => {
    await declare(['a', 'b']);
    const issueId = await fx.insertIssue();
    sites.a.serving = PUSHED;
    sites.b.serving = PUSHED;

    await record([issueId]);

    expect((await fx.stored(issueId)).status).toBe('closed');
  });
});
