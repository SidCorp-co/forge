/**
 * Anyone confirms a fix (owner, 2026-10-07): any member may verify a resolved item and the decision
 * names them; a sweep dates the first time an item reads resolved, and once the project's window has
 * run it writes what the record reads on the item and the item waits on a holder of feedback.approve
 * (Feedback lifecycle r14 loop-check): nothing verifies it by itself, a record that reads it gone
 * included (`feedback-triage-checklist-e2e.test.ts` proves that case; the owner's ruling of
 * 2026-10-14); an item still inside its window is left alone; the BA's Needs you holds no verify row.
 * An item that names no criterion promises no record date, and is never held in silence. Saying
 * whether a held item's problem is gone is the holder's own act but no person's decision, so it reads `waiting`, never Needs you (REQ-48 BC-11: a list draws
 * needs_you only for rows the decisions read holds).
 *
 * @direct-test-of packages/core/src/lib/standing-times.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { ago, feedback, issue, world } from '../helpers/forecast-world.js';
import { declareControls } from '../helpers/project-controls.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'ann' | 'bo';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const seq = (fb: string) => Number(fb.slice(3));

/** An item reported by `who`, answered by a triager: it reads resolved at once. */
async function resolved(who: Who, title: string): Promise<string> {
  const fb = ok(
    await say(who, 'POST', at('/feedback'), {
      kind: 'question',
      title,
      screen: '/projects/hop/board',
    }),
    201,
  ).feedback.key as string;
  ok(
    await say('owner', 'POST', item(fb, 'triage'), {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: 'It is by design.',
    }),
  );
  return fb;
}

const read = async (fb: string, who: Who = 'owner'): Promise<Doc> =>
  ok(await say(who, 'GET', item(fb))).feedback;

const bell = async (who: Who) => {
  await settleOutbox();
  return (await db.execute(sql`
    SELECT n.title, n.body
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${people[who]} AND n.type = 'feedback_message' AND n.project_id = ${projectId}
     ORDER BY n.created_at
  `)) as unknown as { title: string; body: string }[];
};

async function seen(fb: string, daysAgo: number) {
  await db.execute(sql`
    UPDATE feedback SET resolved_seen_at = now() - make_interval(days => ${daysAgo})
     WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
  `);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann', 'bo'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.ann, 'member');
  await addProjectMember(projectId, people.bo, 'member');
  // the window, the record note and the person's confirm are a strict project's (owner 2026-11-08,
  // D5): outside strict the ship is the verify, which its own describe below holds
  await declareControls(projectId, people.owner, { gates: { profile: 'strict' } });
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('any member confirms a fix, and the record says who and when', () => {
  it('lets a member who is neither reporter nor approver verify, and names them', async () => {
    const fb = await resolved('ann', 'Why is the board read-only?');
    expect((await read(fb, 'bo')).can).toMatchObject({ verify: true });
    const out = ok(await say('bo', 'POST', item(fb, 'verify'), {})).feedback;
    expect(out.status).toBe('verified');
    expect(out.verified).toMatchObject({ how: 'person', by: people.bo, byReporter: false });
    expect((out.verified as Doc).at).toBeTruthy();
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      decidedBy: people.bo,
      decidedAgency: 'human',
    });
  });

  it('keeps an item whose fix shipped off the triager’s Needs you: nobody is owed the act', async () => {
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const fb = await feedback(w, [carrier.id]);
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${fb}`);
    const r = res.body.feedback as Doc;
    expect(r.phase).toBe('resolved');
    expect(r.attentionGroup, 'no verify row on Needs you').not.toBe('needs_you');
    expect(r.waitingOn).not.toMatchObject({ kind: 'you' });
  });
});

describe('Forge verifies no item nobody confirmed: past its window it writes what the record reads for a person', () => {
  it('dates the first sighting, and past the window leaves an item no criterion vouches for to a person', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Is the export meant to skip blanks?');
    const first = await sweepResolvedFeedback();
    expect(first.dated).toBeGreaterThanOrEqual(1);
    const dated = await read(fb);
    expect(dated.status).toBe('triaged');
    expect(
      dated.recordCheck,
      'its triage named no criterion: no record date is promised',
    ).toBeNull();

    await seen(fb, 8);
    const before = (await bell('ann')).length;
    const past = await sweepResolvedFeedback();
    expect(past).toMatchObject({ verified: 0 });
    expect(past.held).toBeGreaterThanOrEqual(1);
    const out = await read(fb);
    expect(out.status, 'its triage named no criterion, so nothing says the problem is gone').toBe(
      'triaged',
    );
    expect(out.phase).toBe('resolved');
    expect(out.can).toMatchObject({ verify: true });
    expect(out.verifyHeld).toMatchObject({ why: expect.stringContaining('named no criterion') });
    expect((await bell('ann')).slice(before)).toEqual([]);
  });

  it('leaves an item still inside its window, however recently it was last swept', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Why does the badge say Planned?');
    // the reporter's own triaged notice is already there; the sweeps add nothing to it
    const before = (await bell('ann')).length;
    await sweepResolvedFeedback();
    await seen(fb, 6);
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('triaged');
    expect((await bell('ann')).slice(before)).toEqual([]);
  });

  it('counts from the project’s own window, and a reopened item starts over', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Reopen me before the window ends');
    await sweepResolvedFeedback();
    await seen(fb, 5);
    ok(await say('ann', 'POST', item(fb, 'reopen'), { reason: 'It is not fixed.' }));
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('reopened');
    const stamp = (await db.execute(
      sql`SELECT resolved_seen_at FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}`,
    )) as unknown as { resolved_seen_at: Date | null }[];
    expect(
      stamp[0]?.resolved_seen_at,
      'a reopen clears the date the window counts from',
    ).toBeNull();
  });
});

describe('an item triaged before a criterion could be named (FB-19, 31, 36, 48, 51, 102, 110 on forge-dev)', () => {
  it('promises no date, and past its window the sweep writes why on it and asks a holder of feedback.approve', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const fb = await feedback(w, [carrier.id]);
    const get = async () =>
      (await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${fb}`)).body
        .feedback as Doc;
    const heldAt = async () =>
      (
        (await db.execute(
          sql`SELECT verify_held_at FROM feedback WHERE project_id = ${w.projectId} AND fb_seq = ${seq(fb)}`,
        )) as unknown as { verify_held_at: Date | null }[]
      )[0]?.verify_held_at ?? null;

    // a strict project keeps the confirm a person's, and with no criterion only a person can say it is gone
    await declareControls(w.projectId, w.userId, { gates: { profile: 'strict' } });
    // its reporter was told it shipped, so loop close question one is settled and two is what is owed
    const told = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/feedback/${fb}/tell-shipped`,
      {},
    );
    expect(told.status, JSON.stringify(told.body)).toBeLessThan(300);
    await sweepResolvedFeedback();
    const inside = await get();
    expect(inside.phase).toBe('resolved');
    expect(inside.recordCheck, 'no criterion: the record can never say').toBeNull();
    expect(inside.verifyHeld).toBeNull();
    expect(inside.waitingOn).toMatchObject({
      says: { rule: { key: 'feedback.rule.verifyByPerson' } },
    });

    await db.execute(sql`
      UPDATE feedback SET resolved_seen_at = now() - make_interval(days => 8)
       WHERE project_id = ${w.projectId} AND fb_seq = ${seq(fb)}
    `);
    const past = await sweepResolvedFeedback();
    expect(
      past.noted,
      'the sweep wrote what the record reads on the item it held',
    ).toBeGreaterThanOrEqual(1);
    const held = await get();
    expect(held.status).toBe('triaged');
    expect(held.verifyHeld).toMatchObject({
      why: 'its triage named no criterion, so no verdict can say the problem is gone',
    });
    expect(held.waitingOn).toMatchObject({
      kind: 'you',
      says: {
        act: { key: 'standing.act.sayIfGone' },
        rule: { key: 'feedback.rule.verifyHeld' },
      },
    });
    expect(
      held.attentionGroup,
      'a holder of feedback.approve owes the answer: their own act, on their Needs you (ISS-924)',
    ).toBe('needs_you');

    const first = await heldAt();
    expect(first).not.toBeNull();
    await sweepResolvedFeedback();
    expect(await heldAt(), 'the same reason is written once').toEqual(first);
  });
});

// owner 2026-11-08 (D5, G5): outside strict a resolved item whose carrier shipped is done. The sweep
// records it verified by ship as Forge's own decision, naming the version where the carrier names
// one, and nothing waits on its reporter or the master; strict keeps the person's confirm (above).
describe('outside strict the ship is the verify, and nothing waits on the reporter', () => {
  it('reads Done at once, and the sweep records it verified by ship as Forge, telling its reporter', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const fb = await feedback(w, [carrier.id]);
    const get = async () =>
      (await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${fb}`)).body
        .feedback as Doc;
    const before = await get();
    expect(before.phase).toBe('resolved');
    expect(before.attentionGroup).toBe('done');
    expect(before.chip).toBe('done');
    expect(before.waitingOn).toMatchObject({ kind: 'none' });

    const swept = await sweepResolvedFeedback();
    expect(swept.shipped).toBeGreaterThanOrEqual(1);
    const after = await get();
    expect(after.status).toBe('verified');
    expect((after.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      decidedBy: null,
      reason: expect.stringContaining('Verified by ship'),
    });
    const again = await sweepResolvedFeedback();
    expect(again.shipped, 'a verified item is never verified again').toBe(0);
  });
  // the 37 items verified on 2026-11-08 say "reopen this item if the problem returns": that holds
  it('lets its reporter reopen an item verified by ship, with a reason, and no one else without feedback.approve', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const fb = await feedback(w, [carrier.id]);
    await sweepResolvedFeedback();
    const path = `/api/projects/${w.projectId}/feedback/${fb}`;
    const verified = (await api(w.token, 'GET', path)).body.feedback as Doc;
    expect(verified.status).toBe('verified');
    expect(verified.can).toMatchObject({ reopen: true, verify: false });

    const stranger = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, stranger.id, 'member');
    const { signUserToken } = await import('../../src/credentials/jwt.js');
    const theirs = await api(await signUserToken(stranger.id), 'POST', `${path}/reopen`, {
      reason: 'not mine to say',
    });
    expect(JSON.stringify(theirs.body)).toContain('feedback.approve');

    const bare = await api(w.token, 'POST', `${path}/reopen`, { reason: ' ' });
    expect(JSON.stringify(bare.body)).toContain('FEEDBACK_REOPEN_REASON_REQUIRED');

    const reopened = await api(w.token, 'POST', `${path}/reopen`, {
      reason: 'It is back on the board',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const after = reopened.body.feedback as Doc;
    expect(after.status).toBe('reopened');
    expect((after.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'reopened',
      reason: 'It is back on the board',
    });
  });
});

// ISS-1159: sid-desk FB-9 was verified by ship on 0.20.0 ("Verified by ship: its work shipped in
// 0.20.0"), a release that shipped its carrier ISS-18 with c2's latest verdict `fail`. A carrier
// shipped with a failing criterion resolves nothing: the item reads planned naming the criterion, the
// sweep verifies nothing, and the verify door refuses it by name, until c2's latest verdict passes.
// Planted red by reading every closed, released carrier as resolving whatever its verdicts say.
describe('a carrier shipped with a failing criterion verifies nothing (ISS-1159)', () => {
  const verdict = (
    issueId: string,
    n: number,
    word: 'pass' | 'fail' | 'skipped',
    minutesAgo: number,
  ) =>
    db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      commit_sha, author_agency, judge, created_at)
      SELECT c.id, ${issueId}, ${word}, ${`${word} in staging`},
             ${word === 'pass' ? 'commit' : null}, ${word === 'pass' ? 'a'.repeat(40) : null},
             'agent', 'qa', now() - make_interval(mins => ${minutesAgo})
        FROM issue_criteria c WHERE c.issue_id = ${issueId} AND c.n = ${n} AND c.retired_at IS NULL
    `);

  it('keeps FB-9 planned on ISS-18 c2, unverified by the sweep and refused at the door, until c2 passes', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    await db.execute(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${carrier.id}, 1, 'The thread opens at 1280', 1),
             (${carrier.id}, 2, 'The conversation column keeps 360 px with Views open', 2)
    `);
    await verdict(carrier.id, 1, 'pass', 50);
    // c2 passed once, then failed in staging before the cut: its latest verdict is what counts
    await verdict(carrier.id, 2, 'pass', 40);
    await verdict(carrier.id, 2, 'fail', 30);
    const fb = await feedback(w, [carrier.id]);
    const path = `/api/projects/${w.projectId}/feedback/${fb}`;
    const get = async () => (await api(w.token, 'GET', path)).body.feedback as Doc;

    const shipped = await get();
    expect(shipped.phase, 'a release that shipped c2 failing resolves nothing').toBe('planned');
    expect(shipped.chip).toBe('planned');
    expect(shipped.waitingOn).toMatchObject({ kind: 'issue', ref: carrier.key });
    expect(String((shipped.waitingOn as Doc).rule)).toContain(`${carrier.key} c2 failed`);

    await sweepResolvedFeedback();
    expect((await get()).status, 'the sweep never verifies it by ship').toBe('triaged');

    const door = await api(w.token, 'POST', `${path}/verify`, {});
    expect(door.status).not.toBe(200);
    expect(JSON.stringify(door.body)).toContain('FEEDBACK_CARRIER_FAILED');
    expect(JSON.stringify(door.body)).toContain(`${carrier.key} c2`);

    // a later verdict passes c2: the carrier ships clean, and the ship verifies it as before
    await verdict(carrier.id, 2, 'pass', 10);
    expect((await get()).phase).toBe('resolved');
    await sweepResolvedFeedback();
    const after = await get();
    expect(after.status).toBe('verified');
    expect((after.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      reason: expect.stringContaining('Verified by ship'),
    });
  });
  // ISS-1234: agenfold FB-283 was verified by ship on 0.293.0 while its carrier ISS-382's c3 (an act on
  // production waiting on the owner's approval) was recorded `skipped`, owed live; its reporter was told
  // it was done. A criterion owed live holds the ship sweep: the item reads resolved, waits on that
  // criterion by name, and is verified by ship once its latest verdict passes.
  // Planted red by reading only `fail` as holding the sweep (the code before ISS-1234).
  it('holds FB-283 unverified while its carrier ISS-382 c3 is skipped, and verifies it once c3 passes', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    await db.execute(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position)
      VALUES (${carrier.id}, 1, 'The agent holds serp-api in General', 1),
             (${carrier.id}, 3, 'The tool is added on production once the owner approves', 3)
    `);
    await verdict(carrier.id, 1, 'pass', 50);
    await verdict(carrier.id, 3, 'skipped', 30);
    const fb = await feedback(w, [carrier.id]);
    const path = `/api/projects/${w.projectId}/feedback/${fb}`;
    const get = async () => (await api(w.token, 'GET', path)).body.feedback as Doc;

    const shipped = await get();
    expect(shipped.phase, 'it shipped, so it reads resolved').toBe('resolved');
    expect(shipped.waitingOn).toMatchObject({ kind: 'issue', ref: carrier.key });
    expect(String((shipped.waitingOn as Doc).rule)).toContain(`${carrier.key} c3 shipped owed`);

    await sweepResolvedFeedback();
    const held = await get();
    expect(held.status, 'the sweep does not verify it by ship').toBe('triaged');
    expect((held.decisions as Doc[]).some((d) => d.decision === 'verified')).toBe(false);

    await verdict(carrier.id, 3, 'pass', 10);
    await sweepResolvedFeedback();
    const after = await get();
    expect(after.status).toBe('verified');
    expect((after.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      reason: expect.stringContaining('Verified by ship'),
    });
  });
});
