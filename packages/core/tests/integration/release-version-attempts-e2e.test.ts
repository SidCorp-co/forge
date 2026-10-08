/**
 * A release's version means what shipped; attempts are not versions (ADR 0011). Found live on HOP
 * 2026-10-07: one roster of 26 issues cut three times wore 0.3.0, 0.4.0 and 0.5.0, and the releases
 * list read three releases, two of which never reached anyone. Through the app's own routes, against
 * real Postgres: the cut, the abort, the after-the-fact declaration and the read model.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { stampReleaseShipped } from '../../src/pipeline/run-records.js';
import { recordCarried } from '../../src/release-batch/carried.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const REFUSAL =
  'what Autoflow serves does not carry 1 landing(s) of this release: ISS-54 landed workflow `193` (`hop_referral`) at draft `999dcf6d`, and Autoflow publishes no version of workflow `193` (`hop_referral`): nothing of it is live';

async function cut(issueIds: string[]): Promise<{ runId: string; version: string }> {
  const r = await call('POST', '/release-batches', { issueIds });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { runId: String(r.body.runId), version: String(r.body.version) };
}

/** A box took the release job: what makes a silent abort's version unknowable from here. */
async function boxTook(runId: string): Promise<void> {
  await db.execute(sql`UPDATE jobs SET dispatched_at = now() WHERE pipeline_run_id = ${runId}`);
}

/** The finish refused, as HOP's 0.3.0 and 0.4.0 recorded it, before the abort ended the run. */
async function finishRefused(runId: string): Promise<void> {
  const finish = {
    requestId: '0392503b-5d2e-4505-a455-7fcecafb9da4',
    state: 'failed',
    commit: null,
    requestedBy: { type: 'user', id: ownerId, agency: 'human' },
    acceptedAt: '2026-10-07T19:53:01.520Z',
    updatedAt: '2026-10-07T19:53:02.679Z',
    version: 3,
    owner: null,
    leaseUntil: null,
    workerStarts: 1,
    closed: null,
    failed: null,
    refusal: { code: 'RELEASE_NOT_VERIFIED', reason: REFUSAL, live: null },
    verification: null,
    finishedAt: '2026-10-07T19:53:02.679Z',
  };
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = metadata || jsonb_build_object('finish', ${JSON.stringify(finish)}::jsonb)
     WHERE id = ${runId}
  `);
}

async function abort(runId: string, body: Record<string, unknown>) {
  const r = await call('POST', `/release-batches/${runId}/abort`, {
    reason: 'finish refused',
    ...body,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function ship(runId: string): Promise<void> {
  await stampReleaseShipped(runId);
  await closeRunIfOneShot(runId, 'completed');
}

type Cut = {
  n: number;
  version: string;
  outcome: string;
  refusal: { code: string | null; text: string; says: unknown } | null;
  decidedBy: { name: string } | null;
  rule: { decided: string; from: string | null; carriers: { kind: string; name: string }[] };
  carried: { kind: string; name: string }[] | null;
  roster: { key: string; title: string }[];
};
type Summary = { version: string; state: string; cutCount: number; continuedAs: unknown };

const list = async () => {
  const r = await call('GET', '/releases');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { releases: Summary[]; counts: Record<string, number> };
};
const page = async (version: string) => {
  const r = await call('GET', `/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.release as Summary & { cuts: Cut[]; gates: { code: string }[] };
};

describe('HOP: one roster cut three times, nothing outside Forge carrying the version', () => {
  it('reads as one version with three attempts', async () => {
    const roster = [await fx.insertIssue(), await fx.insertIssue()];

    const first = await cut(roster);
    await boxTook(first.runId);
    await finishRefused(first.runId);
    await abort(first.runId, { pushed: false });

    const second = await cut([...roster].reverse());
    expect(
      second.version,
      'a re-cut of the same roster wears the version its first cut claimed',
    ).toBe(first.version);
    await boxTook(second.runId);
    await finishRefused(second.runId);
    await abort(second.runId, { pushed: false });

    const third = await cut(roster);
    expect(third.version).toBe(first.version);
    await boxTook(third.runId);
    await ship(third.runId);

    const listed = await list();
    expect(listed.releases.map((r) => [r.version, r.state, r.cutCount])).toEqual([
      [first.version, 'shipped', 3],
    ]);
    expect(listed.counts.stopped).toBe(0);

    const shown = await page(first.version);
    expect(shown.cuts.map((c) => [c.n, c.version, c.outcome])).toEqual([
      [1, first.version, 'aborted'],
      [2, first.version, 'aborted'],
      [3, first.version, 'shipped'],
    ]);
    expect(shown.cuts[0]?.refusal).toEqual({
      code: 'RELEASE_NOT_VERIFIED',
      text: REFUSAL,
      says: { key: 'releases.refused.notVerified' },
    });
    expect(shown.cuts[0]?.decidedBy?.name).toBeTruthy();
    expect(shown.cuts.map((c) => c.rule.decided)).toEqual(['first', 'reused', 'reused']);
    expect(shown.cuts[0]?.carried).toEqual([]);
    expect(shown.cuts.map((c) => c.roster.length)).toEqual([2, 2, 2]);
  });
});

describe('a tag pushed on attempt 1', () => {
  it('makes the next attempt take a new version, and the release page names the tag', async () => {
    const roster = [await fx.insertIssue()];
    const first = await cut(roster);
    await boxTook(first.runId);
    await abort(first.runId, { carried: [{ kind: 'tag', name: `v${first.version}` }] });

    const second = await cut(roster);
    expect(second.version).not.toBe(first.version);

    const shown = await page(second.version);
    expect(shown.cuts.map((c) => c.version)).toEqual([first.version, second.version]);
    expect(shown.cuts[1]?.rule).toEqual({
      decided: 'bumped',
      from: first.version,
      carriers: [{ kind: 'tag', name: `v${first.version}` }],
      line: null,
      taken: false,
    });

    const listed = await list();
    expect(listed.releases.map((r) => [r.version, r.cutCount])).toEqual([[second.version, 2]]);
    const earlier = await page(first.version);
    expect(earlier.continuedAs).toEqual({ version: second.version, shipped: false });
  });

  it('refuses an abort whose pushed and carried tell two stories, aborting nothing', async () => {
    const first = await cut([await fx.insertIssue()]);
    const r = await call('POST', `/release-batches/${first.runId}/abort`, {
      reason: 'x',
      pushed: false,
      carried: [{ kind: 'tag', name: 'v0.1.0' }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('RELEASE_CARRIED_CONTRADICTS');
    const [run] = await rows<{ status: string }>(
      sql`SELECT status FROM pipeline_runs WHERE id = ${first.runId}`,
    );
    expect(run?.status).toBe('running');
  });
});

describe('an attempt that never said what left its box', () => {
  it('refuses the re-cut by name until somebody says, and the draft shows the gate', async () => {
    const roster = [await fx.insertIssue()];
    const first = await cut(roster);
    await boxTook(first.runId);
    await abort(first.runId, {});

    const draft = await page(first.version);
    expect(draft.state).toBe('draft');
    expect(draft.gates.map((g) => g.code)).toContain('RELEASE_VERSION_UNDECIDED');

    const refused = await call('POST', '/release-batches', { issueIds: roster });
    expect(refused.status).toBe(409);
    const text = JSON.stringify(refused.body);
    expect(text).toContain('RELEASE_VERSION_UNDECIDED');
    expect(text).toContain(first.version);
    expect(text).toContain(first.runId);

    const declared = await call('POST', `/release-batches/${first.runId}/carried`, { carried: [] });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);

    const second = await cut(roster);
    expect(second.version).toBe(first.version);
  });

  it('refuses a declaration on an attempt still running, or on one that shipped', async () => {
    const roster = [await fx.insertIssue()];
    const open = await cut(roster);
    const live = await call('POST', `/release-batches/${open.runId}/carried`, { carried: [] });
    expect(live.status).toBe(409);
    expect(JSON.stringify(live.body)).toContain('RELEASE_CARRIED_RUN_OPEN');

    await ship(open.runId);
    const done = await call('POST', `/release-batches/${open.runId}/carried`, { carried: [] });
    expect(done.status).toBe(409);
    expect(JSON.stringify(done.body)).toContain('RELEASE_CARRIED_SHIPPED');
  });
});

describe('the version lock', () => {
  it('holds a re-cut while a declaration of what carries the version is uncommitted, then bumps past it', async () => {
    const roster = [await fx.insertIssue()];
    const first = await cut(roster);
    await boxTook(first.runId);
    await abort(first.runId, { carried: [] });

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let declaring: Promise<unknown> = Promise.resolve();
    const locked = new Promise<void>((ready) => {
      declaring = db.transaction(async (tx) => {
        await recordCarried(first.runId, [{ kind: 'tag', name: 'v-late' }], ownerId, tx);
        ready();
        await held;
      });
    });
    await locked;
    let settled = false;
    const second = cut(roster).then((c) => {
      settled = true;
      return c;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, 'the cut waits on the version lock the declaration holds').toBe(false);
    release();
    await declaring;
    const after = await second;
    expect(after.version).not.toBe(first.version);
    const shown = await page(after.version);
    expect(shown.cuts[1]?.rule.carriers).toEqual([{ kind: 'tag', name: 'v-late' }]);
  });
});

describe('a roster that changed', () => {
  it('is a new release on a new version, and the earlier one stays as it ended', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const first = await cut([a, b]);
    await boxTook(first.runId);
    await abort(first.runId, { pushed: false });

    const second = await cut([a]);
    expect(second.version).not.toBe(first.version);
    const shown = await page(second.version);
    expect(shown.cuts.map((c) => c.rule.decided)).toEqual(['first']);
    const listed = await list();
    const byVersion = Object.fromEntries(listed.releases.map((r) => [r.version, r]));
    expect(byVersion[first.version]).toMatchObject({
      state: 'aborted',
      cutCount: 1,
      continuedAs: null,
    });
    expect(byVersion[second.version]).toMatchObject({ state: 'in_progress', cutCount: 1 });
  });
});

describe('history cut before the rule (HOP 0.3.0, 0.4.0, 0.5.0) stays as it is', () => {
  it('links each aborted version to the release that shipped the same roster, rewriting nothing', async () => {
    const roster = [await fx.insertIssue('closed'), await fx.insertIssue('closed')];
    const ids = JSON.stringify(roster);
    const legacy = async (
      version: string,
      at: string,
      meta: Record<string, unknown>,
      shipped: boolean,
    ) => {
      const [row] = await rows<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, kind, status, started_at, metadata, release_version, release_released_at)
        VALUES (${projectId}, 'system', ${shipped ? 'completed' : 'cancelled'}, ${at}::timestamptz,
                ${JSON.stringify({ source: 'release-batch', issueIds: JSON.parse(ids), ...meta })}::jsonb,
                ${version}, ${shipped ? sql`${at}::timestamptz + interval '2 minutes'` : null})
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO jobs (project_id, pipeline_run_id, type, status, created_by, dispatched_at)
        VALUES (${projectId}, ${row?.id}, 'release_batch', ${shipped ? 'done' : 'cancelled'}, ${ownerId}, ${at}::timestamptz)
      `);
      return String(row?.id);
    };
    await legacy(
      '0.3.0',
      '2026-10-07T19:43:26Z',
      { abort: { reason: 'finish refused', by: ownerId, roster: 'released' } },
      false,
    );
    await legacy(
      '0.4.0',
      '2026-10-07T20:56:47Z',
      { abort: { reason: 'finish refused', by: ownerId, roster: 'released', pushed: false } },
      false,
    );
    await legacy('0.5.0', '2026-10-07T21:39:04Z', {}, true);
    const before = await rows(
      sql`SELECT id, release_version, status, metadata FROM pipeline_runs ORDER BY started_at`,
    );

    const listed = await list();
    expect(listed.releases.map((r) => [r.version, r.cutCount])).toEqual([['0.5.0', 3]]);
    expect((await page('0.3.0')).continuedAs).toEqual({ version: '0.5.0', shipped: true });
    expect((await page('0.4.0')).continuedAs).toEqual({ version: '0.5.0', shipped: true });
    const shipped = await page('0.5.0');
    expect(shipped.cuts.map((c) => [c.version, c.outcome, c.rule.decided])).toEqual([
      ['0.3.0', 'aborted', 'unrecorded'],
      ['0.4.0', 'aborted', 'unrecorded'],
      ['0.5.0', 'shipped', 'unrecorded'],
    ]);
    expect(shipped.cuts[0]?.carried).toBeNull();

    expect(
      await rows(
        sql`SELECT id, release_version, status, metadata FROM pipeline_runs ORDER BY started_at`,
      ),
    ).toEqual(before);
  });

  it('a version an earlier rule handed to another roster is not worn again by a re-cut', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue('closed');
    const legacy = async (
      version: string,
      at: string,
      roster: string[],
      meta: Record<string, unknown>,
      shipped: boolean,
    ) => {
      const [row] = await rows<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, kind, status, started_at, metadata, release_version, release_released_at)
        VALUES (${projectId}, 'system', ${shipped ? 'completed' : 'cancelled'}, ${at}::timestamptz,
                ${JSON.stringify({ source: 'release-batch', issueIds: roster, ...meta })}::jsonb,
                ${version}, ${shipped ? sql`${at}::timestamptz + interval '2 minutes'` : null})
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO jobs (project_id, pipeline_run_id, type, status, created_by, dispatched_at)
        VALUES (${projectId}, ${row?.id}, 'release_batch', ${shipped ? 'done' : 'cancelled'}, ${ownerId}, ${at}::timestamptz)
      `);
    };
    const nothingLeft = { abort: { reason: 'x', by: ownerId, roster: 'released', pushed: false } };
    await legacy('0.4.0', '2026-10-06T20:33:00Z', [a], nothingLeft, false);
    await legacy('0.4.0', '2026-10-06T21:05:00Z', [b], {}, true);

    const next = await cut([a]);
    expect(next.version, '0.4.0 already names the release that shipped another roster').toBe(
      '0.5.0',
    );
    const shown = await page('0.5.0');
    expect(shown.cuts.at(-1)?.rule).toMatchObject({
      decided: 'bumped',
      from: '0.4.0',
      taken: true,
    });
  });
});
