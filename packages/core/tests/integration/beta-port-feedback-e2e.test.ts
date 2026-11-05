/**
 * ISS-982 (owner 2026-11-05: a forge-beta issue enters dev at the product layer). A beta issue in
 * flight or landed on beta (in_progress, developed or later, or merge-marked) is left there and named
 * in every fire's report, and nothing is filed for it (sidpeak ISS-620/621 became open dev issues).
 * A ported Feedback item mirrors back from what its triage made of it: once the issue it was routed
 * to lands, beta follows once with one log comment naming the dev key; an answer or a decline is
 * commented once and moves nothing. The mirror never moves beta backward, for a twin (sidpeak ISS-1/2
 * at needs_info would have pulled beta's developed back) or a Feedback-born issue, and the report
 * names each held move once. forge-beta is a stub HTTP server this file starts and stops. Against
 * real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/mirror.ts
 * @direct-test-of packages/core/src/beta-port/markers.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/beta-port/report.ts
 * @direct-test-of packages/core/src/beta-port/ports.ts
 * @direct-test-of packages/core/src/feedback/relations.ts
 * @direct-test-of packages/core/src/db/schema-beta-port.ts
 * @direct-test-of packages/core/src/work-ports.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  betaPortScheduleOn,
  devFeedbackOf,
  devIssuesOf,
  fireOnce,
  putBetaSecret,
  type Say,
  seedTwin,
  setDevStatus,
} from '../helpers/beta-port-harness.js';
import {
  beforeRuling,
  beta,
  betaIssue,
  outsideGitDocument,
  RULING_AT,
  type StubIssue,
  startBeta,
  stopBeta,
  TOKEN,
  writeRuling,
} from '../helpers/beta-port-world.js';
import { closeWorld, ok, requester, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let say: Say;
let ownerId = '';
let twin = { id: '', slug: '' };
let betaProjectId = '';
let scheduleId = '';

beforeAll(async () => {
  testEnv();
  const baseUrl = await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as Say;
  betaProjectId = randomUUID();
  beta.projects = [{ id: betaProjectId, slug: twin.slug }];
  beta.configs.set(betaProjectId, outsideGitDocument());
  beta.issues.set(betaProjectId, []);
  scheduleId = await betaPortScheduleOn(say, scheduleProjectId);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-url', baseUrl);
  await putBetaSecret(say, scheduleProjectId, 'forge-beta-token', TOKEN);
  await writeRuling(scheduleProjectId, RULING_AT);
}, 120_000);

afterAll(async () => {
  await stopBeta();
  await closeWorld();
});

const fire = () => fireOnce(say, scheduleId);
const push = (...issues: StubIssue[]) => beta.issues.get(betaProjectId)?.push(...issues);
const movesOf = (b: StubIssue) =>
  beta.transitions.filter((t) => t.issueId === b.id).map((t) => t.toStatus);
const commentsOf = (b: StubIssue) => beta.comments.get(b.id) ?? [];

/** The Feedback item a beta issue was ported as: its id and key. */
async function itemOf(b: StubIssue): Promise<{ id: string; key: string }> {
  const [row] = await rows<{ id: string; fb_seq: number }>(
    sql`SELECT f.id, f.fb_seq FROM beta_port_pairs p JOIN feedback f ON f.id = p.dev_feedback_id WHERE p.beta_issue_id = ${b.id}`,
  );
  if (!row) throw new Error(`beta ${b.displayId} was not ported as Feedback`);
  return { id: row.id, key: `FB-${row.fb_seq}` };
}

/** A triage by the twin's owner; a decline carries no checklist answers. */
const triage = (fbKey: string, body: Record<string, unknown>) =>
  say('owner', 'POST', `/api/projects/${twin.id}/feedback/${fbKey}/triage`, {
    ...(body.route === 'decline' ? {} : { answers: TRIAGE_ANSWERS }),
    ...body,
  });

describe('a beta issue in flight or landed on beta (ISS-982 2)', () => {
  it('is left on beta, named with its status in every report, and nothing is filed or written for it', async () => {
    const developed = betaIssue(40, { status: 'developed' });
    const inFlight = betaIssue(41, { status: 'in_progress' });
    const releasing = betaIssue(42, { status: 'awaiting_release' });
    const closed = betaIssue(43, { status: 'closed' });
    const marked = betaIssue(44, { mergedAt: '2026-11-04T09:00:00.000Z' });
    const old = betaIssue(45, { status: 'developed', createdAt: beforeRuling() });
    const waiting = betaIssue(46);
    const left = [developed, inFlight, releasing, closed, marked, old];
    push(...left, waiting);

    const first = await fire();
    expect(first.status, JSON.stringify(first)).toBe('success');
    expect(first.output).toContain('left on beta, in flight or landed there (5):');
    for (const line of [
      'beta ISS-40 (developed)',
      'beta ISS-41 (in_progress)',
      'beta ISS-42 (awaiting_release)',
      'beta ISS-43 (closed)',
      'beta ISS-44 (open, merge-marked)',
    ]) {
      expect(first.output).toContain(`${twin.slug}: ${line}`);
    }
    expect(first.output).not.toContain('ISS-45');
    // only the one still waiting on beta arrives, and as Feedback
    const items = await devFeedbackOf(twin.id);
    expect(items.map((i) => i.title)).toEqual([waiting.title]);
    // no beta web origin is set on this project: the item names its beta key and carries no link a
    // person could not open, and the fire says which secret would give it one (ISS-982 c1)
    expect(items[0]?.body ?? '').not.toContain('Beta: ');
    expect(first.output).toContain('the project secret integration/forge-beta-web-url is not set');
    expect(await devIssuesOf(twin.id)).toHaveLength(0);
    for (const b of left) {
      expect(commentsOf(b), b.displayId).toEqual([]);
      expect(movesOf(b), b.displayId).toEqual([]);
    }

    const second = await fire();
    expect(second.output).toContain('left on beta, in flight or landed there (5):');
    expect(second.output).toContain('ported: none');
    expect(await devFeedbackOf(twin.id)).toHaveLength(1);
    const pairs = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM beta_port_pairs WHERE beta_issue_id IN (${developed.id}, ${inFlight.id}, ${releasing.id}, ${closed.id}, ${marked.id}, ${old.id})`,
    );
    expect(pairs[0]?.n).toBe(0);
  });
});

describe('a ported Feedback item mirrors what its triage made of it (ISS-982 3)', () => {
  const routed = betaIssue(50);
  const answered = betaIssue(51);
  const declined = betaIssue(52);

  it('follows the issue its triage filed once it lands, once, with one log comment naming the dev key', async () => {
    push(routed);
    await fire();
    const item = await itemOf(routed);
    const triaged = ok(
      await triage(item.key, { route: 'issue', createIssue: { title: 'Fix what beta 50 asks' } }),
    );
    const carrier = (triaged.feedback as { route: { carriers: { key: string }[] } }).route
      .carriers[0]?.key as string;
    expect(carrier).toMatch(/^ISS-\d+$/);
    const [issue] = await devIssuesOf(twin.id);
    expect(`ISS-${issue?.iss_seq}`).toBe(carrier);
    const before = commentsOf(routed).length;

    // not landed: beta keeps waiting, nothing is written
    await setDevStatus(issue?.id as string, 'in_progress');
    const working = await fire();
    expect(movesOf(routed)).toEqual([]);
    expect(commentsOf(routed)).toHaveLength(before);
    expect(working.output).not.toContain(carrier);

    await setDevStatus(issue?.id as string, 'awaiting_release');
    const landed = await fire();
    expect(beta.transitions.filter((t) => t.issueId === routed.id)).toEqual([
      {
        issueId: routed.id,
        toStatus: 'awaiting_release',
        reason: `Mirrored from forge-dev ${carrier}, which moved to awaiting_release.`,
      },
    ]);
    expect(routed.status).toBe('awaiting_release');
    expect(commentsOf(routed).slice(before)).toEqual([
      `forge-dev ${carrier} (from ${item.key}) reached awaiting_release; this issue follows it.`,
    ]);
    expect(landed.output).toContain(
      `${twin.slug}: ${carrier}: open → awaiting_release (beta ${routed.displayId})`,
    );

    await fire();
    expect(movesOf(routed)).toEqual(['awaiting_release']);
    expect(commentsOf(routed).slice(before)).toHaveLength(1);
  });

  it('comments an answer or a decline on beta once, and moves no status', async () => {
    push(answered, declined);
    await fire();
    const a = await itemOf(answered);
    const d = await itemOf(declined);
    ok(await triage(a.key, { route: 'answer', answer: 'It works as designed: export is weekly.' }));
    const refused = await triage(d.key, { route: 'decline', note: 'Out of scope for SidHRM.' });
    expect(refused.status, JSON.stringify(refused.json)).toBe(200);
    const before = new Map([answered, declined].map((b) => [b.id, commentsOf(b).length]));

    const told = await fire();
    expect(commentsOf(answered).slice(before.get(answered.id))).toEqual([
      `forge-dev ${a.key} was answered: It works as designed: export is weekly. This issue's status is not moved.`,
    ]);
    expect(commentsOf(declined).slice(before.get(declined.id))).toEqual([
      `forge-dev ${d.key} was declined. This issue's status is not moved.`,
    ]);
    expect(told.output).toContain(`${twin.slug}: ${a.key} → beta ${answered.displayId} (answer)`);
    expect(told.output).toContain(`${twin.slug}: ${d.key} → beta ${declined.displayId} (declined)`);

    await fire();
    for (const b of [answered, declined]) {
      expect(movesOf(b)).toEqual([]);
      expect(commentsOf(b).slice(before.get(b.id))).toHaveLength(1);
    }
  });
});

describe('the mirror never moves beta backward (ISS-982 4)', () => {
  it('leaves a developed beta issue at developed while its twin parks at needs_info, and names the held move once', async () => {
    const source = betaIssue(60, { status: 'developed' });
    push(source);
    const dev = await seedTwin(say, twin, source, 'in_progress');
    await setDevStatus(dev.id, 'needs_info');
    beta.transitions.length = 0;

    const held = await fire();
    expect(movesOf(source)).toEqual([]);
    expect(source.status).toBe('developed');
    expect(held.output).toContain('held, never moved backward (1):');
    expect(held.output).toContain(
      `${twin.slug}: ${dev.key} at needs_info: beta ISS-60 keeps developed, not moved back to needs_info`,
    );

    const again = await fire();
    expect(movesOf(source)).toEqual([]);
    expect(again.output).not.toContain('held, never moved backward');

    // forward still mirrors: the twin landing and closing moves beta on
    await setDevStatus(dev.id, 'awaiting_release');
    await fire();
    expect(movesOf(source)).toEqual(['awaiting_release']);
  });

  it('leaves a beta issue closed on beta while the Feedback-born issue stands at awaiting_release', async () => {
    const source = betaIssue(61);
    push(source);
    await fire();
    const item = await itemOf(source);
    ok(await triage(item.key, { route: 'issue', createIssue: { title: 'Fix beta 61' } }));
    const [issue] = await rows<{ id: string; iss_seq: number }>(
      sql`SELECT i.id, i.iss_seq FROM feedback_route_issues r JOIN issues i ON i.id = r.issue_id WHERE r.feedback_id = ${item.id}`,
    );
    // closed on beta by its own people meanwhile
    source.status = 'closed';
    await setDevStatus(issue?.id as string, 'awaiting_release');
    beta.transitions.length = 0;
    const commented = commentsOf(source).length;

    const held = await fire();
    expect(movesOf(source)).toEqual([]);
    expect(source.status).toBe('closed');
    expect(commentsOf(source)).toHaveLength(commented);
    expect(held.output).toContain(
      `${twin.slug}: ISS-${issue?.iss_seq} at awaiting_release: beta ISS-61 keeps closed, not moved back to awaiting_release`,
    );
  });
});
