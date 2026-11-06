/**
 * ISS-923 (owner ruling 2026-11-03, `beta-issues-are-worked-on-dev`) and ISS-982 (owner 2026-11-05: a
 * beta issue enters dev at the product layer): a `beta_port` schedule's fire files each forge-beta
 * issue filed or reopened after the ruling, not yet ported and still waiting on beta, as one Feedback
 * item of the same-slug project, with the beta key, link and body as its provenance and the FB key
 * commented back on beta, and creates no issue; an older one is counted and never ported; it never
 * ports one twice; an issue twin made before ISS-982 still mirrors a dev status move onto beta once,
 * and comments a move beta refuses once; a close beta refuses for want of a shipped record is finished
 * the nearest legal way; it names a beta project with no twin, a missing secret and a missing ruling,
 * creating nothing for them; `/run` answers 202 before the beta reads, and the fire settles after;
 * and the token never leaves. forge-beta is a stub HTTP server this file starts and stops. Against
 * real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/schedules/dispatch.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/schedules/beta-port-dispatch.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/client.ts
 * @direct-test-of packages/core/src/project-config/secret-read.ts
 * @direct-test-of packages/core/src/beta-port/ports.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 * @direct-test-of packages/core/src/feedback/service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  betaPortScheduleOn,
  devFeedbackOf,
  devIssuesOf,
  fireOnce,
  putBetaSecret,
  type Say,
  seedTwin,
} from '../helpers/beta-port-harness.js';
import {
  afterRuling,
  beforeRuling,
  beta,
  betaIssue,
  fireRow,
  outsideGitDocument,
  RULING_AT,
  type StubIssue,
  settledFire,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, ok, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let baseUrl = '';
let say: Say;
let ownerId = '';
let scheduleProjectId = '';
let twin = { id: '', slug: '' };
let betaProjectId = '';
const logged: string[] = [];

beforeAll(async () => {
  testEnv();
  baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { logger } = await import('../../src/lib/logger.js');
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as typeof say;
  betaProjectId = randomUUID();
  beta.configs.set(betaProjectId, outsideGitDocument());
  beta.projects = [
    { id: betaProjectId, slug: twin.slug },
    { id: randomUUID(), slug: `no-twin-${randomUUID().slice(0, 8)}` },
  ];
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await stopBeta();
  await closeWorld();
});

const betaPortSchedule = () => betaPortScheduleOn(say, scheduleProjectId);
/** Beta's web origin, a different host from its API, as forge-beta serves them. */
const BETA_WEB = 'https://forge-beta-web.test';

const setSecret = (name: string, value: string) =>
  putBetaSecret(say, scheduleProjectId, name, value);
const fire = (id: string) => fireOnce(say, id);
const devIssues = () => devIssuesOf(twin.id);
const devFeedback = () => devFeedbackOf(twin.id);

let scheduleId = '';

describe('a beta port fire (ISS-923)', () => {
  it('(d) a missing secret is refused by name and nothing is created', async () => {
    scheduleId = await betaPortSchedule();
    beta.issues.set(betaProjectId, [betaIssue(1)]);
    const settled = await fire(scheduleId);
    expect(settled.http).toBe(422);
    expect(settled).toMatchObject({
      status: 'skipped',
      reason: 'gate-refused',
      refusal: 'BETA_PORT_SECRET_MISSING',
    });
    expect(settled.output).toContain('secret://integration/forge-beta-url');
    expect(await devIssues()).toHaveLength(0);
    expect(await devFeedback()).toHaveLength(0);
    expect(beta.comments.size).toBe(0);
  });

  it('(a) a missing ruling refuses the fire by name, before beta is read, and nothing is created', async () => {
    await setSecret('forge-beta-url', baseUrl);
    await setSecret('forge-beta-token', TOKEN);
    // where a person opens a beta issue: beta's web origin, not its API host (ISS-982 c1)
    await setSecret('forge-beta-web-url', BETA_WEB);
    const settled = await fire(scheduleId);
    expect(settled.http).toBe(422);
    expect(settled).toMatchObject({
      status: 'skipped',
      reason: 'gate-refused',
      refusal: 'BETA_PORT_CUTOFF_MISSING',
    });
    expect(settled.output).toContain('beta-issues-are-worked-on-dev');
    expect(beta.requests).toBe(0);
    expect(await devIssues()).toHaveLength(0);
  });

  it('(ISS-982 1) a new beta issue is filed as one Feedback item of the same-slug project, beta told its key, and no issue is created; a second fire ports nothing', async () => {
    await writeRuling(scheduleProjectId, RULING_AT);
    const settled = await fire(scheduleId);
    expect(settled.http).toBe(202);
    expect(settled.status, JSON.stringify(settled)).toBe('success');
    expect(settled.output).toContain(
      `cutoff: the owner's ruling beta-issues-are-worked-on-dev, ${RULING_AT.toISOString()}`,
    );
    expect(await devIssues()).toHaveLength(0);
    const [item, ...more] = await devFeedback();
    expect(more).toHaveLength(0);
    const source = (beta.issues.get(betaProjectId) as StubIssue[])[0] as StubIssue;
    expect(item).toMatchObject({
      kind: 'bug',
      severity: 'high',
      title: source.title,
      status: 'new',
      reported_by: ownerId,
      reporter_agency: 'agent',
      where_seen: 'forge-beta ISS-1',
      dedup_key: `forge-beta:${source.id}`,
    });
    const lines = (item?.body ?? '').split('\n');
    expect(lines[0]).toBe(`Ported from forge-beta ISS-1 (${source.id}).`);
    expect(lines[1]).toBe(`Beta: ${BETA_WEB}/projects/${twin.slug}/issues/${source.id}`);
    expect(item?.body).not.toContain(baseUrl);
    expect(item?.body).toContain('What beta issue 1 asks for.');
    const fbKey = `FB-${item?.fb_seq}`;
    expect(beta.comments.get(source.id)).toEqual([`Ported to forge-dev: ${fbKey}`]);
    expect(settled.output).toContain(`${twin.slug}: beta ISS-1 → ${fbKey}`);
    const [pair] = await rows<{ dev_issue_id: string | null; dev_feedback_id: string | null }>(
      sql`SELECT dev_issue_id, dev_feedback_id FROM beta_port_pairs WHERE beta_issue_id = ${source.id}`,
    );
    expect(pair).toEqual({ dev_issue_id: null, dev_feedback_id: item?.id });

    const again = await fire(scheduleId);
    expect(again.output).toContain('ported: none');
    expect(await devFeedback()).toHaveLength(1);
    expect(await devIssues()).toHaveLength(0);
    expect(beta.comments.get(source.id)).toHaveLength(1);
  });

  it('(d) a beta project with no dev twin is named in the report, and nothing is created for it', async () => {
    const settled = await fire(scheduleId);
    const lonely = beta.projects[1]?.slug as string;
    expect(settled.output).toContain('beta projects with no dev twin (1):');
    expect(settled.output).toContain(lonely);
    const elsewhere = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE body LIKE 'Ported from forge-beta%' AND project_id <> ${twin.id}`,
    );
    expect(elsewhere[0]?.n).toBe(0);
  });

  it('(b) a beta issue with the marker comment, or named on a dev issue, is never ported again', async () => {
    const marked = betaIssue(2);
    const named = betaIssue(3);
    beta.issues.get(betaProjectId)?.push(marked, named);
    // a hand port: beta carries the marker naming a key the twin does not hold
    beta.comments.set(marked.id, ['Ported to forge-dev: ISS-999 by hand']);
    // a port whose beta comment failed: the dev issue's first line names the beta id
    await say('owner', 'POST', `/api/projects/${twin.id}/issues`, {
      title: 'Hand ported',
      description: `Ported from forge-beta ISS-3 (${named.id}).\n\nby hand`,
      status: 'draft',
    });
    const before = (await devIssues()).length;
    const items = (await devFeedback()).length;
    const first = await fire(scheduleId);
    const second = await fire(scheduleId);
    expect(await devIssues()).toHaveLength(before);
    expect(await devFeedback()).toHaveLength(items);
    for (const settled of [first, second]) {
      // a marker naming nothing in the twin holds the row and says what to write (ISS-1045)
      expect(settled.output).toContain(
        `${twin.slug}: beta ISS-2: marked ported to ISS-999, which names nothing in ${twin.slug}`,
      );
      expect(settled.output).not.toContain('ISS-2 (marked ported');
      expect(settled.output).not.toMatch(/ISS-[23] → /);
    }
    expect(first.output).toContain('ISS-3 (named on ');
    // the dev-named one is adopted as a pair, so the second fire does not read it again
    expect(beta.comments.get(named.id) ?? []).toEqual([]);
    const pairs = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM beta_port_pairs WHERE beta_issue_id IN (${named.id}, ${(beta.issues.get(betaProjectId) as StubIssue[])[0]?.id as string})`,
    );
    expect(pairs[0]?.n).toBe(2);
  });

  it('(c) a twin made before ISS-982 still mirrors a dev move once, and a move beta refuses is commented once', async () => {
    const source = betaIssue(4);
    beta.issues.get(betaProjectId)?.push(source);
    const { id: devId, key: devKey } = await seedTwin(say, twin, source);

    ok(
      await say('owner', 'POST', `/api/issues/${devId}/transition`, {
        toStatus: 'on_hold',
        reason: 'waiting on the owner',
      }),
    );
    beta.transitions.length = 0;
    const moved = await fire(scheduleId);
    expect(beta.transitions).toEqual([
      {
        issueId: source.id,
        toStatus: 'on_hold',
        reason: `Mirrored from forge-dev ${devKey}, which moved to on_hold.`,
      },
    ]);
    expect(source.status).toBe('on_hold');
    expect(moved.output).toContain(`${devKey}: open → on_hold`);
    await fire(scheduleId);
    expect(beta.transitions).toHaveLength(1);

    beta.refuseInto.set('dropped', 'BETA_REFUSES_THIS_EDGE');
    ok(
      await say('owner', 'POST', `/api/issues/${devId}/transition`, {
        toStatus: 'dropped',
        reason: 'not worth it',
      }),
    );
    const refused = await fire(scheduleId);
    expect(refused.output).toContain('BETA_REFUSES_THIS_EDGE');
    await fire(scheduleId);
    expect(beta.transitions.filter((t) => t.toStatus === 'dropped')).toHaveLength(1);
    const told = (beta.comments.get(source.id) ?? []).filter((b) => b.includes('refused'));
    expect(told).toEqual([
      `forge-dev ${devKey} moved to dropped; forge-beta refused the matching move: BETA_REFUSES_THIS_EDGE.`,
    ]);
  });
});

describe('a beta port fire after the ruling (ISS-923)', () => {
  it('(a) an issue filed before the ruling is counted and never ported, unless it was reopened after it', async () => {
    const old = betaIssue(10, { createdAt: beforeRuling() });
    const reopened = betaIssue(11, { createdAt: beforeRuling(), reopenCount: 1, status: 'reopen' });
    const reopenedEarly = betaIssue(12, { createdAt: beforeRuling(), reopenCount: 2 });
    const uncounted = betaIssue(13, { createdAt: beforeRuling() });
    delete uncounted.reopenCount;
    const bare = betaIssue(14, { description: 'The body a list row leaves out.' });
    beta.bare.add(bare.id);
    beta.activity.set(reopened.id, [
      {
        action: 'issue.statusChanged',
        payload: { from: 'open', to: 'reopen' },
        createdAt: beforeRuling(),
      },
      { action: 'comment.created', payload: { body: 'still broken' }, createdAt: afterRuling() },
      {
        action: 'issue.statusChanged',
        payload: { from: 'closed', to: 'reopen' },
        createdAt: afterRuling(),
      },
    ]);
    beta.activity.set(reopenedEarly.id, [
      {
        action: 'issue.statusChanged',
        payload: { from: 'open', to: 'reopen' },
        createdAt: beforeRuling(),
      },
    ]);
    beta.issues.get(betaProjectId)?.push(old, reopened, reopenedEarly, uncounted, bare);
    const before = (await devFeedback()).length;

    const settled = await fire(scheduleId);
    const ported = (await devFeedback()).slice(before);
    expect(ported.map((d) => d.title).sort()).toEqual([reopened.title, bare.title]);
    expect(ported.find((d) => d.title === bare.title)?.body).toContain(
      'The body a list row leaves out.',
    );
    expect(settled.output).toContain(`${twin.slug}: beta ISS-11 → `);
    expect(settled.output).toContain(`${twin.slug}: beta ISS-14 → `);
    expect(settled.output).toContain('before the ruling (1):');
    expect(settled.output).toContain(
      `${twin.slug}: 3 (not ported; 1 of them carry no reopenCount on beta, so a reopen since cannot be told)`,
    );
    for (const left of [old, reopenedEarly, uncounted]) {
      expect(beta.comments.get(left.id) ?? []).toEqual([]);
    }

    const again = await fire(scheduleId);
    expect(await devFeedback()).toHaveLength(before + 2);
    expect(again.output).toContain(`${twin.slug}: 3 (not ported;`);
  });

  it('(c) /run answers 202 with its fire before a slow beta answers, and the fire settles with its report', async () => {
    beta.delayMs = 1500;
    const pressed = Date.now();
    const run = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
    const answeredIn = Date.now() - pressed;
    expect(run.status).toBe(202);
    const fireId = (run.json as { fireId: string }).fireId;
    expect(fireId).toMatch(/^[0-9a-f-]{36}$/);
    expect(answeredIn).toBeLessThan(beta.delayMs);
    expect((await fireRow(fireId))?.status).toBe('running');

    // a second press while it runs starts nothing: two at once would port the same issue twice
    const second = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
    expect(second.status).toBe(422);
    expect(JSON.stringify(second.json)).toContain('BETA_PORT_FIRE_LIVE');

    const settled = await settledFire(fireId);
    beta.delayMs = 0;
    expect(['success', 'skipped']).toContain(settled.status);
    const read = ok(
      await say('owner', 'GET', `/api/projects/${scheduleProjectId}/automation/fires/${fireId}`),
    );
    expect((read.fire as { output: string }).output).toContain('cutoff: the owner');
    expect((read.fire as { output: string }).output).toBe(settled.output);
  });

  it('(c) an error after the answer settles the fire failed with the error', async () => {
    const { openFire } = await import('../../src/schedules/fires.js');
    const { settleAfterAnswer } = await import('../../src/schedules/dispatch.js');
    const fireId = await openFire({ scheduleId, projectId: scheduleProjectId, trigger: 'manual' });
    settleAfterAnswer(fireId, async () => {
      throw new Error('beta went away after the answer');
    });
    const settled = await settledFire(fireId);
    expect(settled.status).toBe('failed');
    expect(settled.error).toContain('beta went away after the answer');
  });
});

describe('a beta port close (ISS-923)', () => {
  it('(d) a close beta refuses CLOSE_REQUIRES_SHIPPED is made legal and closed, or moved to the nearest legal status, once', async () => {
    const closes = betaIssue(20);
    const releases = betaIssue(21);
    const legacy = betaIssue(22);
    beta.issues.get(betaProjectId)?.push(closes, releases, legacy);
    for (const b of [closes, releases, legacy]) await seedTwin(say, twin, b);
    const pairOf = async (betaId: string) =>
      (
        await rows<{
          dev_issue_id: string;
          last_mirrored_status: string | null;
          last_tried_status: string | null;
          beta_reached: string | null;
        }>(
          sql`SELECT dev_issue_id, last_mirrored_status, last_tried_status, beta_reached FROM beta_port_pairs WHERE beta_issue_id = ${betaId}`,
        )
      )[0];
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    const { db } = await import('../../src/db/client.js');
    const keys = new Map<string, string>();
    for (const b of [closes, releases, legacy]) {
      const pair = await pairOf(b.id);
      expect(pair, b.displayId).toBeDefined();
      await withKernelMarker(db, (tx) =>
        tx.execute(
          sql`UPDATE issues SET status = 'closed', merged_at = now(), merged_landing = 'https://dev.example/landed' WHERE id = ${pair?.dev_issue_id as string}`,
        ),
      );
      const [dev] = await rows<{ iss_seq: number }>(
        sql`SELECT iss_seq FROM issues WHERE id = ${pair?.dev_issue_id as string}`,
      );
      keys.set(b.id, `ISS-${dev?.iss_seq}`);
    }
    // the old rule's record: the close was tried and refused, and the pair claimed it mirrored
    await rows(
      sql`UPDATE beta_port_pairs SET last_mirrored_status = 'closed', last_tried_status = NULL, beta_reached = NULL WHERE beta_issue_id = ${legacy.id}`,
    );
    beta.closeNeedsMark = true;
    beta.closeAfterMark.set(releases.id, 'CLOSE_ONLY_BY_RELEASE');
    beta.transitions.length = 0;
    const commentsBefore = [...beta.comments.values()].flat().length;

    const settled = await fire(scheduleId);
    const movesOf = (b: StubIssue) =>
      beta.transitions.filter((t) => t.issueId === b.id).map((t) => t.toStatus);
    expect(movesOf(closes)).toEqual(['closed', 'closed']);
    expect(movesOf(releases)).toEqual(['closed', 'closed', 'awaiting_release']);
    expect(movesOf(legacy)).toEqual(['closed', 'closed']);
    // (b) the twin lands outside git, so its mark names the landing and no commit or target
    for (const b of [closes, releases, legacy]) {
      expect(beta.marks.get(b.id)?.landing).toBe(
        `forge-dev ${keys.get(b.id)} at https://dev.example/landed`,
      );
      expect(beta.marks.get(b.id)).not.toHaveProperty('commit');
      expect(beta.marks.get(b.id)).not.toHaveProperty('target');
    }
    expect([closes.status, releases.status, legacy.status]).toEqual([
      'closed',
      'awaiting_release',
      'closed',
    ]);
    expect(await pairOf(closes.id)).toMatchObject({
      last_mirrored_status: 'closed',
      last_tried_status: 'closed',
      beta_reached: 'closed',
    });
    const held = await pairOf(releases.id);
    expect(held).toMatchObject({ last_tried_status: 'closed', beta_reached: 'awaiting_release' });
    expect(held?.last_mirrored_status).not.toBe('closed');
    expect(await pairOf(legacy.id)).toMatchObject({
      last_mirrored_status: 'closed',
      last_tried_status: 'closed',
      beta_reached: 'closed',
    });
    expect(settled.output).toContain(
      `${twin.slug}: ${keys.get(closes.id)}: open → closed (beta ISS-20)`,
    );
    expect(settled.output).toContain(
      `${twin.slug}: ${keys.get(releases.id)}: open → awaiting_release (beta ISS-21)`,
    );
    expect(settled.output).toContain('CLOSE_ONLY_BY_RELEASE');
    // no dev release carries it, so none is recorded on beta: the close beta refused is commented
    // on its issue once, by name (ISS-1005), and nothing else is
    expect(settled.output).toContain('BETA_PORT_NO_DEV_RELEASE');
    expect([...beta.comments.values()].flat()).toHaveLength(commentsBefore + 1);
    expect(beta.comments.get(releases.id)?.at(-1)).toContain(
      `forge-dev ${keys.get(releases.id)} was closed; forge-beta refused to close this issue to match: CLOSE_REQUIRES_SHIPPED`,
    );

    // the close it refused stays owed: tried again, with no second mark or comment; the rest are done
    const moves = beta.transitions.length;
    const marks = beta.marks.size;
    await fire(scheduleId);
    expect(beta.transitions.slice(moves).map((t) => [t.issueId, t.toStatus])).toEqual([
      [releases.id, 'closed'],
    ]);
    expect(beta.marks.size).toBe(marks);
    expect([...beta.comments.values()].flat()).toHaveLength(commentsBefore + 1);
    beta.closeNeedsMark = false;
  });
});

describe('a beta port bound and its token (ISS-923)', () => {
  it('(b) the per-fire bound leaves the rest for the next fire, counting only issues filed after the ruling', async () => {
    const cap = await createTestProject(ownerId);
    const capBetaId = randomUUID();
    beta.projects.push({ id: capBetaId, slug: cap.slug });
    const fresh = Array.from({ length: 27 }, (_, i) => betaIssue(100 + i));
    const old = Array.from({ length: 4 }, (_, i) =>
      betaIssue(200 + i, { createdAt: beforeRuling() }),
    );
    beta.issues.set(capBetaId, [...old, ...fresh]);

    const settled = await fire(scheduleId);
    const [n] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${cap.id}`,
    );
    expect(n?.n).toBe(25);
    expect(settled.output).toContain('left for the next fire: 2');
    expect(settled.output).toContain(`${cap.slug}: 4 (not ported)`);
    expect(settled.output).toMatch(new RegExp(`${cap.slug}: beta ISS-1\\d\\d → FB-\\d+`));

    const next = await fire(scheduleId);
    const [m] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${cap.id}`,
    );
    expect(m?.n).toBe(27);
    expect(next.output).not.toContain('left for the next fire');
  }, 60_000);

  it('(e) the token never appears in a report, a comment, an issue or a log', async () => {
    const outputs = await rows<{ text: string }>(
      sql`SELECT coalesce(output, '') || coalesce(error, '') || coalesce(refusal, '') AS text FROM schedule_runs WHERE schedule_id = ${scheduleId}`,
    );
    expect(outputs.length).toBeGreaterThan(3);
    const comments = [...beta.comments.values()].flat();
    const issues = (await devIssues()).map((i) => `${i.title}\n${i.description}`);
    const items = (
      await rows<{ text: string }>(
        sql`SELECT title || coalesce(body, '') || coalesce(where_seen, '') AS text FROM feedback`,
      )
    ).map((r) => r.text);
    expect(items.length).toBeGreaterThan(3);
    for (const text of [
      ...outputs.map((o) => o.text),
      ...comments,
      ...issues,
      ...items,
      ...logged,
    ]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(beta.unauthorised).toBe(0);
  });
});
