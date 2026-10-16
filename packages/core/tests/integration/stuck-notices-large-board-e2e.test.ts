/**
 * ISS-1229 r12 — judge-26 saw no stuck-issue notice delivered on beta, which holds 2,141 idle Open
 * issues and 850 owed closes. Each sweep reads 200 rows a pass, a notice is delivered only once it
 * has stood pending two evaluations, and a pending one unseen for three is dropped: on a board over
 * three pages a notice was raised, dropped and raised again for ever. These cases run the sweeps
 * as the sweeper does — once a minute on their own clock, conditions re-evaluated after them — on a
 * board of five full pages, and follow one issue's notice by its row id.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
type Sweep = (now: Date) => Promise<unknown>;
const sweeps = {} as Record<'idle' | 'owed-close', Sweep>;
let reevaluate: (now: Date) => Promise<unknown>;
let notifyTransitions: typeof import('../../src/notifications/notify-transitions.js');
let hooksMod: typeof import('../../src/pipeline/hooks.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  const idle = await import('../../src/pipeline/idle-issues.js');
  const stranded = await import('../../src/pipeline/stranded-issues.js');
  sweeps.idle = (now) => idle.reconcileIdleIssues(now);
  sweeps['owed-close'] = (now) => stranded.detectOwedCloses(now);
  reevaluate = (await import('../../src/pipeline/reevaluate-conditions.js')).reevaluateConditions;
  notifyTransitions = await import('../../src/notifications/notify-transitions.js');
  hooksMod = await import('../../src/pipeline/hooks.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Five full pages of the 200 a pass reads: more than the three passes a pending notice outlives. */
const BOARD = 1_000;

type World = { ownerId: string; projectId: string };

async function world(): Promise<World> {
  const owner = await createTestUser(harness.db);
  const org = await seedOrg(harness.db, owner.id);
  const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
  return { ownerId: owner.id, projectId: project.id };
}

/** `BOARD` stuck issues at `status`, each entered (and merged, where asked) two days before `t0`. */
async function board(w: World, status: string, t0: number, merged: boolean): Promise<void> {
  const base = new Date(t0 - 48 * HOUR).toISOString();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, merged_at, created_at, updated_at)
    SELECT gen_random_uuid(), ${w.projectId}::uuid, 'stuck ' || g, ${status}, ${w.ownerId}::uuid, g,
           CASE WHEN ${merged} THEN ${base}::timestamptz + (g || ' seconds')::interval END,
           ${base}::timestamptz + (g || ' seconds')::interval,
           ${base}::timestamptz + (g || ' seconds')::interval
      FROM generate_series(1, ${BOARD}) g
  `);
}

async function target(w: World, status: string, at: number, merged: boolean): Promise<string> {
  const id = randomUUID();
  const iso = new Date(at).toISOString();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, merged_at, created_at, updated_at)
    VALUES (${id}::uuid, ${w.projectId}::uuid, 'the one watched', ${status}, ${w.ownerId}::uuid,
            ${BOARD + 1}, ${merged ? iso : null}::timestamptz, ${iso}::timestamptz, ${iso}::timestamptz)
  `);
  return id;
}

/** What the sweeper does each minute for one arm: the sweep, then the re-evaluation after it. */
async function tick(sweep: Sweep, now: Date): Promise<void> {
  await sweep(now);
  await reevaluate(now);
}

interface Notice {
  id: string;
  state: string;
  resolvedAt: string | null;
}

async function noticesOf(issueId: string): Promise<Notice[]> {
  return (await harness.db.execute(sql`
    SELECT id, state, resolved_at AS "resolvedAt" FROM notifications
     WHERE issue_id = ${issueId}::uuid AND type = 'issue_stranded'
  `)) as unknown as Notice[];
}

async function toldAbout(userId: string, issueId: string): Promise<number> {
  const rows = (await harness.db.execute(sql`
    SELECT count(*)::int AS n
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${userId}::uuid AND n.issue_id = ${issueId}::uuid
       AND n.type = 'issue_stranded' AND d.resolved_notice = false
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Run `sweep` once a minute from `from` to `to`, and follow `issueId`'s notice: every row id it
 * stood under, the minutes it stood under none after it was first raised, and the minute it was
 * first delivered.
 */
async function follow(args: {
  sweep: Sweep;
  from: number;
  to: number;
  ownerId: string;
  issueId: string;
}): Promise<{ ids: Set<string>; deliveredAt: number | null; gaps: number }> {
  const ids = new Set<string>();
  let deliveredAt: number | null = null;
  let raised = false;
  let gaps = 0;
  for (let t = args.from; t <= args.to; t += MINUTE) {
    await tick(args.sweep, new Date(t));
    const standing = (await noticesOf(args.issueId)).filter((n) => n.resolvedAt === null);
    for (const n of standing) ids.add(n.id);
    if (raised && standing.length === 0) gaps += 1;
    if (standing.length > 0) raised = true;
    if (deliveredAt === null && (await toldAbout(args.ownerId, args.issueId)) > 0) deliveredAt = t;
  }
  return { ids, deliveredAt, gaps };
}

describe('a stuck-issue notice on a board of five full pages', () => {
  it('tells the admin about an Open issue within five minutes of its fifteen, raised once', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);
    const watched = await target(w, 'open', t0, false);

    const seen = await follow({
      sweep: sweeps.idle,
      from: t0 + 5 * MINUTE,
      to: t0 + 30 * MINUTE,
      ownerId: w.ownerId,
      issueId: watched,
    });

    expect(seen.deliveredAt, 'delivered at all').not.toBeNull();
    expect((seen.deliveredAt ?? 0) - t0).toBeLessThanOrEqual(20 * MINUTE);
    expect(seen.ids.size, 'one notice, never dropped and raised again').toBe(1);
    expect(seen.gaps).toBe(0);
  }, 600_000);

  it('tells the admin about an owed close within five minutes of its six hours, raised once', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'developed', t0, true);
    const watched = await target(w, 'developed', t0, true);

    const seen = await follow({
      sweep: sweeps['owed-close'],
      from: t0 + 6 * HOUR - 10 * MINUTE,
      to: t0 + 6 * HOUR + 15 * MINUTE,
      ownerId: w.ownerId,
      issueId: watched,
    });

    expect(seen.deliveredAt, 'delivered at all').not.toBeNull();
    expect((seen.deliveredAt ?? 0) - t0).toBeLessThanOrEqual(6 * HOUR + 5 * MINUTE);
    expect(seen.ids.size, 'one notice, never dropped and raised again').toBe(1);
    expect(seen.gaps).toBe(0);
  }, 600_000);

  it('raises every stuck issue on the board once, and delivers each', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);

    for (let t = t0; t <= t0 + 12 * MINUTE; t += MINUTE) await tick(sweeps.idle, new Date(t));

    const rows = (await harness.db.execute(sql`
      SELECT count(*)::int AS raised,
             count(*) FILTER (WHERE state = 'firing')::int AS firing,
             count(DISTINCT issue_id)::int AS issues
        FROM notifications WHERE type = 'issue_stranded'
    `)) as unknown as Array<{ raised: number; firing: number; issues: number }>;
    expect(rows[0]).toEqual({ raised: BOARD, firing: BOARD, issues: BOARD });
  }, 600_000);
});

describe('a delivered idle notice whose issue is no longer stuck', () => {
  /** The watched issue's notice delivered on a board this size, so the sweep's pages are full. */
  async function delivered(): Promise<{ w: World; watched: string; t: number }> {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);
    const watched = await target(w, 'open', t0 - 20 * MINUTE, false);
    let t = t0;
    for (; t <= t0 + 4 * MINUTE; t += MINUTE) await tick(sweeps.idle, new Date(t));
    expect(await toldAbout(w.ownerId, watched)).toBe(1);
    return { w, watched, t };
  }

  it('resolves at the status move itself', async () => {
    const { w, watched } = await delivered();
    const bus = new hooksMod.HooksBus();
    notifyTransitions.registerTransitionNotifications(bus);
    await harness.db.execute(
      sql`UPDATE issues SET status = 'confirmed' WHERE id = ${watched}::uuid`,
    );

    await bus.emit('transition', {
      issueId: watched,
      projectId: w.projectId,
      actor: { type: 'user', id: w.ownerId, agency: 'human' },
      from: 'open',
      to: 'confirmed',
      reopenCount: 0,
    });

    const standing = (await noticesOf(watched)).filter((n) => n.resolvedAt === null);
    expect(standing, 'resolved before any sweep ran').toEqual([]);
  }, 600_000);

  it('resolves once a run is working it, on the sweep that sees it', async () => {
    const { w, watched, t } = await delivered();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${randomUUID()}::uuid, ${w.projectId}::uuid, ${watched}::uuid, 'issue', 'running', now())
    `);

    for (let s = t; s <= t + 8 * MINUTE; s += MINUTE) await tick(sweeps.idle, new Date(s));

    const notices = await noticesOf(watched);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.state).toBe('resolved');
  }, 600_000);
});

describe('the rows a pass owes a sighting, on a board that is hard to read', () => {
  it('reaches a due issue behind 200 newer ones on a project nobody can be told about', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);
    const owner = await createTestUser(harness.db);
    const org = await seedOrg(harness.db, owner.id);
    const nobody = await createTestProject(harness.db, owner.id, { orgId: org.id });
    await harness.db.execute(
      sql`DELETE FROM project_members WHERE project_id = ${nobody.id}::uuid`,
    );
    await harness.db.execute(sql`DELETE FROM organization_members WHERE org_id = ${org.id}::uuid`);
    const watched = await target(w, 'open', t0, false);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, created_at, updated_at)
      SELECT gen_random_uuid(), ${nobody.id}::uuid, 'untold ' || g, 'open', ${owner.id}::uuid, g,
             ${new Date(t0).toISOString()}::timestamptz + (g * 5 || ' milliseconds')::interval,
             ${new Date(t0).toISOString()}::timestamptz + (g * 5 || ' milliseconds')::interval
        FROM generate_series(1, 200) g
    `);

    const seen = await follow({
      sweep: sweeps.idle,
      from: t0 + 10 * MINUTE,
      to: t0 + 22 * MINUTE,
      ownerId: w.ownerId,
      issueId: watched,
    });

    expect(seen.deliveredAt, 'delivered at all').not.toBeNull();
    expect((seen.deliveredAt ?? 0) - t0).toBeLessThanOrEqual(20 * MINUTE);
  }, 600_000);

  it('reaches a due issue behind 200 newer ones a live claim keeps from being raised', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);
    const watched = await target(w, 'open', t0, false);
    const claimed = new Date(t0 + 10 * MINUTE).toISOString();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, session_context, created_at, updated_at)
      SELECT gen_random_uuid(), ${w.projectId}::uuid, 'claimed ' || g, 'open', ${w.ownerId}::uuid, ${BOARD + 1} + g,
             jsonb_build_object('lease', jsonb_build_object(
               'holder', 'holder-' || g, 'minutes', 600, 'renewedAt', ${claimed}::text,
               'history', jsonb_build_array(jsonb_build_object('at', ${claimed}::text, 'how', 'claim')))),
             ${new Date(t0).toISOString()}::timestamptz + (g * 5 || ' milliseconds')::interval,
             ${new Date(t0).toISOString()}::timestamptz + (g * 5 || ' milliseconds')::interval
        FROM generate_series(1, 200) g
    `);

    const seen = await follow({
      sweep: sweeps.idle,
      from: t0 + 10 * MINUTE,
      to: t0 + 22 * MINUTE,
      ownerId: w.ownerId,
      issueId: watched,
    });

    expect(seen.deliveredAt, 'delivered at all').not.toBeNull();
    expect((seen.deliveredAt ?? 0) - t0).toBeLessThanOrEqual(20 * MINUTE);
  }, 600_000);

  it('reaches an issue that comes due while the fresh read is part way through 1,000 it cannot raise', async () => {
    const w = await world();
    const t0 = Date.now();
    const claimed = new Date(t0 + 10 * MINUTE).toISOString();
    await board(w, 'open', t0, false);
    await harness.db.execute(sql`
      UPDATE issues SET session_context = jsonb_build_object('lease', jsonb_build_object(
        'holder', 'holder-' || iss_seq, 'minutes', 600, 'renewedAt', ${claimed}::text,
        'history', jsonb_build_array(jsonb_build_object('at', ${claimed}::text, 'how', 'claim'))))
    `);
    const watched = await target(w, 'open', t0, false);

    const seen = await follow({
      sweep: sweeps.idle,
      from: t0 + 14 * MINUTE,
      to: t0 + 25 * MINUTE,
      ownerId: w.ownerId,
      issueId: watched,
    });

    expect(seen.deliveredAt, 'delivered at all').not.toBeNull();
    expect((seen.deliveredAt ?? 0) - t0).toBeLessThanOrEqual(20 * MINUTE);
  }, 600_000);

  it('keeps a backlog a cleared wedge releases pending until it is seen again', async () => {
    const w = await world();
    const t0 = Date.now();
    const issueId = await target(w, 'open', t0 - HOUR, false);
    const long = new Date(t0 - HOUR).toISOString();
    const [wedge] = (await harness.db.execute(sql`
      INSERT INTO notifications (project_id, type, kind, tier, state, title, resolution_key,
                                 pending_since, last_seen_at, created_at, resolved_at)
      VALUES (${w.projectId}::uuid, 'pipeline_wedge', 'condition', 'page', 'resolved', 'wedge',
              'wedge:cleared', ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz,
              ${new Date(t0).toISOString()}::timestamptz)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await harness.db.execute(sql`
      INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                                 inhibited_by, pending_since, last_seen_at, created_at)
      VALUES (${w.projectId}::uuid, ${issueId}::uuid, 'issue_stranded', 'condition', 'ticket',
              'inhibited', 'held', ${`issue:${issueId}:idle`}, ${wedge?.id}::uuid,
              ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz)
    `);

    await reevaluate(new Date(t0));
    await reevaluate(new Date(t0 + MINUTE));

    expect((await noticesOf(issueId)).map((n) => n.state)).toEqual(['pending']);
  }, 60_000);

  it('releases a backlog in batches a pass can see again, holding the rest rather than dropping it', async () => {
    const w = await world();
    const t0 = Date.now();
    await board(w, 'open', t0, false);
    const long = new Date(t0 - HOUR).toISOString();
    const [wedge] = (await harness.db.execute(sql`
      INSERT INTO notifications (project_id, type, kind, tier, state, title, resolution_key, created_at, resolved_at)
      VALUES (${w.projectId}::uuid, 'pipeline_wedge', 'condition', 'page', 'resolved', 'wedge',
              'wedge:cleared', ${long}::timestamptz, ${new Date(t0).toISOString()}::timestamptz)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await harness.db.execute(sql`
      INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                                 inhibited_by, pending_since, last_seen_at, created_at)
      SELECT i.project_id, i.id, 'issue_stranded', 'condition', 'ticket', 'inhibited', 'held',
             'issue:' || i.id || ':idle', ${wedge?.id}::uuid,
             ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz
        FROM issues i
    `);
    // Each was raised by an idle pass, which writes its finding on the row before it raises.
    await harness.db.execute(
      sql`UPDATE issues SET session_context = jsonb_build_object('strand', '{}'::jsonb)`,
    );
    const states = async () =>
      (await harness.db.execute(sql`
        SELECT state, count(*)::int AS n FROM notifications
         WHERE type = 'issue_stranded' GROUP BY state ORDER BY state
      `)) as unknown as Array<{ state: string; n: number }>;

    await reevaluate(new Date(t0));
    expect(await states()).toEqual([
      { state: 'inhibited', n: BOARD - 200 },
      { state: 'pending', n: 200 },
    ]);

    for (let t = t0 + MINUTE; t <= t0 + 20 * MINUTE; t += MINUTE)
      await tick(sweeps.idle, new Date(t));

    expect(await states()).toEqual([{ state: 'firing', n: BOARD }]);
  }, 600_000);
});
