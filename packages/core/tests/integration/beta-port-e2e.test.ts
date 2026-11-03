/**
 * ISS-923 (owner ruling 2026-11-03, `beta-issues-are-worked-on-dev`): a `beta_port` schedule's fire
 * ports each forge-beta issue filed or reopened after the ruling and not yet ported to the same-slug
 * project here, open, with the beta key and id on its first line and the dev key commented back on
 * beta; an older one is counted and never ported; it never ports one twice; it mirrors a dev status
 * move onto beta once, and comments a move beta refuses once; a close beta refuses for want of a
 * shipped record is finished the nearest legal way; it names a beta project with no twin, a missing
 * secret and a missing ruling, creating nothing for them; `/run` answers 202 before the beta reads,
 * and the fire settles after; and the token never leaves. forge-beta is a stub HTTP server this file
 * starts and stops. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/schedules/dispatch.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/schedules/beta-port-dispatch.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/client.ts
 * @direct-test-of packages/core/src/project-config/secret-read.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  afterRuling,
  beforeRuling,
  beta,
  betaIssue,
  type FireRow,
  fireRow,
  RULING_AT,
  type StubIssue,
  settledFire,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

let baseUrl = '';
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
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

async function betaPortSchedule(): Promise<string> {
  const created = ok(
    await say('owner', 'POST', '/api/schedules', {
      projectId: scheduleProjectId,
      name: 'Beta port',
      cron: '*/15 * * * *',
      kind: 'beta_port',
    }),
    201,
  );
  return created.id as string;
}

async function setSecret(name: string, value: string) {
  ok(
    await say('owner', 'PUT', `/api/projects/${scheduleProjectId}/secrets/integration/${name}`, {
      value,
    }),
  );
}

async function fire(scheduleId: string) {
  const run = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
  if (run.status === 202) {
    const fireId = (run.json as { fireId: string }).fireId;
    return { http: run.status, body: run.json, ...(await settledFire(fireId)) };
  }
  const [settled] = await rows<FireRow>(
    sql`SELECT id, status, reason, refusal, output, error FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY started_at DESC LIMIT 1`,
  );
  if (!settled) throw new Error('the run pressed recorded no fire');
  return { http: run.status, body: run.json, ...settled };
}

const devIssues = () =>
  rows<{
    id: string;
    iss_seq: number;
    status: string;
    description: string | null;
    title: string;
    priority: string;
    category: string | null;
    created_via: string;
    created_by_id: string;
    schedule_run_id: string | null;
  }>(
    sql`SELECT id, iss_seq, status, description, title, priority, category, created_via, created_by_id, schedule_run_id FROM issues WHERE project_id = ${twin.id} ORDER BY iss_seq`,
  );

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
    expect(beta.comments.size).toBe(0);
  });

  it('(a) a missing ruling refuses the fire by name, before beta is read, and nothing is created', async () => {
    await setSecret('forge-beta-url', baseUrl);
    await setSecret('forge-beta-token', TOKEN);
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

  it('(a) a new beta issue is ported open to the same-slug project, first line set, and beta is told the dev key', async () => {
    await writeRuling(scheduleProjectId, RULING_AT);
    const settled = await fire(scheduleId);
    expect(settled.http).toBe(202);
    expect(settled.status, JSON.stringify(settled)).toBe('success');
    expect(settled.output).toContain(
      `cutoff: the owner's ruling beta-issues-are-worked-on-dev, ${RULING_AT.toISOString()}`,
    );
    const [dev, ...more] = await devIssues();
    expect(more).toHaveLength(0);
    const source = (beta.issues.get(betaProjectId) as StubIssue[])[0] as StubIssue;
    expect(dev).toMatchObject({
      status: 'open',
      title: source.title,
      priority: 'high',
      category: 'bug',
      created_via: 'schedule',
      created_by_id: ownerId,
    });
    expect(dev?.schedule_run_id).not.toBeNull();
    const lines = (dev?.description ?? '').split('\n');
    expect(lines[0]).toBe(`Ported from forge-beta ISS-1 (${source.id}).`);
    expect(dev?.description).toContain('What beta issue 1 asks for.');
    const devKey = `ISS-${dev?.iss_seq}`;
    expect(beta.comments.get(source.id)).toEqual([`Ported to forge-dev: ${devKey}`]);
    expect(settled.output).toContain(`${twin.slug}: beta ISS-1 → ${devKey}`);
  });

  it('(d) a beta project with no dev twin is named in the report, and nothing is created for it', async () => {
    const settled = await fire(scheduleId);
    const lonely = beta.projects[1]?.slug as string;
    expect(settled.output).toContain('beta projects with no dev twin (1):');
    expect(settled.output).toContain(lonely);
    const elsewhere = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE description LIKE 'Ported from forge-beta%' AND project_id <> ${twin.id}`,
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
    const first = await fire(scheduleId);
    const second = await fire(scheduleId);
    expect(await devIssues()).toHaveLength(before);
    for (const settled of [first, second]) {
      expect(settled.output).toContain('ISS-2 (marked ported to ISS-999');
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

  it('(c) a dev move is mirrored once, and a move beta refuses is commented once', async () => {
    const source = (beta.issues.get(betaProjectId) as StubIssue[])[0] as StubIssue;
    const [pair] = await rows<{ dev_issue_id: string }>(
      sql`SELECT dev_issue_id FROM beta_port_pairs WHERE beta_issue_id = ${source.id}`,
    );
    const devId = pair?.dev_issue_id as string;
    const [dev] = await rows<{ iss_seq: number }>(
      sql`SELECT iss_seq FROM issues WHERE id = ${devId}`,
    );
    const devKey = `ISS-${dev?.iss_seq}`;

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
    const before = (await devIssues()).length;

    const settled = await fire(scheduleId);
    const ported = (await devIssues()).slice(before);
    expect(ported.map((d) => d.title).sort()).toEqual([reopened.title, bare.title]);
    expect(ported.find((d) => d.title === bare.title)?.description).toContain(
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
    expect(await devIssues()).toHaveLength(before + 2);
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
    await fire(scheduleId);
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
    for (const b of [closes, releases, legacy]) {
      expect(beta.marks.get(b.id)?.landing).toBe(
        `forge-dev ${keys.get(b.id)} at https://dev.example/landed`,
      );
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
    // moved, so nothing is commented
    expect([...beta.comments.values()].flat()).toHaveLength(commentsBefore);

    const moves = beta.transitions.length;
    const marks = beta.marks.size;
    await fire(scheduleId);
    expect(beta.transitions).toHaveLength(moves);
    expect(beta.marks.size).toBe(marks);
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
      sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${cap.id}`,
    );
    expect(n?.n).toBe(25);
    expect(settled.output).toContain('left for the next fire: 2');
    expect(settled.output).toContain(`${cap.slug}: 4 (not ported)`);
    expect(settled.output).toMatch(new RegExp(`${cap.slug}: beta ISS-1\\d\\d → ISS-\\d+`));

    const next = await fire(scheduleId);
    const [m] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${cap.id}`,
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
    for (const text of [...outputs.map((o) => o.text), ...comments, ...issues, ...logged]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(beta.unauthorised).toBe(0);
  });
});
