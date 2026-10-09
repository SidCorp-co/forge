/**
 * Feedback triage answers its checklist (REQ-34 BC-1, BC-2, BC-6; Feedback lifecycle r14
 * triage-check, Feedback triage r16 check and decide), and loop close answers "is the problem gone?"
 * from the record (r14 loop-check, r16 auto-verify). Through the app's own routes against real
 * Postgres: a triage missing an answer is refused naming each question and recorded as refused; a
 * bug against a criterion is triaged with its three answers; a suggestion's accept meets the same
 * check; and past its window an item is verified only where its criterion passes on the running build
 * with nothing filed against it since.
 *
 * @direct-test-of packages/core/src/feedback/triage.ts
 * @direct-test-of packages/core/src/feedback/auto-verify.ts
 * @direct-test-of packages/core/src/feedback/checklist-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { agreedRequirement as agreedRequirementIn } from '../helpers/loop-close.js';

const LIVE = '9999999999999999999999999999999999999999';
const FIXED = '3333333333333333333333333333333333333333';
/** A commit production does not hold; its own sha, since the ancestry answers are cached by commit. */
const UNSHIPPED = '4444444444444444444444444444444444444444';

let projectId: string;
let ownerId: string;
let token: string;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

const on = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

async function ok(r: Promise<{ status: number; body: Doc }>, status?: number): Promise<Doc> {
  const res = await r;
  if (status === undefined) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  else expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

async function refused(r: Promise<{ status: number; body: Doc }>): Promise<Doc[]> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  return res.body.error.refusals as Doc[];
}

const agreedRequirement = () => agreedRequirementIn(token, projectId);

async function fileBug(title: string, target: Doc = { screen: 'The board' }): Promise<string> {
  return (await ok(on('POST', '/feedback', { kind: 'bug', title, ...target }), 201)).feedback
    .key as string;
}

const statusOf = async (fb: string) => (await ok(on('GET', `/feedback/${fb}`))).feedback.status;

describe('a triage missing an answer is refused naming the question (criterion 1)', () => {
  it('refuses a route with no answers, one refusal per question, and records the refused move', async () => {
    const fb = await fileBug('The filter resets');
    const refusals = await refused(on('POST', `/feedback/${fb}/triage`, { route: 'issue' }));
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['CHECKLIST_INCOMPLETE', '/answers/criterion'],
      ['CHECKLIST_INCOMPLETE', '/answers/severity'],
      ['CHECKLIST_INCOMPLETE', '/answers/reproduced'],
    ]);
    expect(refusals[0]?.detail).toMatch(/^Which business criterion does it violate, or none\?/);
    expect(await statusOf(fb), 'a refused triage leaves the item new').toBe('new');
    const kept = (await db.execute(sql`
      SELECT gate, from_status, to_status FROM kernel_refused_moves
       WHERE entity = 'feedback' AND gate = 'feedback_triage'
    `)) as unknown as Doc[];
    expect(kept).toEqual([{ gate: 'feedback_triage', from_status: 'new', to_status: 'triaged' }]);
  });

  it('names the route as a question when neither the triage nor the short form gives one', async () => {
    const fb = await fileBug('The filter resets again');
    const refusals = await refused(
      on('POST', `/feedback/${fb}/triage`, {
        answers: { criterion: 'none', severity: 'low', reproduced: 'Seen once on dev.220.' },
      }),
    );
    expect(refusals.map((r) => r.path)).toEqual(['/answers/route']);
  });

  it('routes once every answer of the full form is given, recording each answer with its source', async () => {
    const fb = await fileBug('The export drops the last row');
    const out = (
      await ok(
        on('POST', `/feedback/${fb}/triage`, {
          route: 'issue',
          answers: {
            criterion: 'none',
            severity: 'high',
            reproduced: 'Exported 3 rows, got 2, on dev.220.',
          },
        }),
      )
    ).feedback;
    expect(out).toMatchObject({ status: 'triaged', severity: 'high' });
    const [move] = (await db.execute(sql`
      SELECT checklist, checklist_answers FROM kernel_transitions
       WHERE entity = 'feedback' AND to_status = 'triaged'
    `)) as unknown as Doc[];
    expect(move?.checklist).toBe('feedback_triage');
    expect(move?.checklist_answers).toEqual([
      { question: 'kind', value: 'bug', provenance: 'given', source: 'record:kind' },
      {
        question: 'requirement',
        value: 'None: it is about no requirement.',
        provenance: 'given',
        source: 'record:requirementId',
      },
      { question: 'criterion', value: 'none', provenance: 'given', source: 'mover' },
      { question: 'severity', value: 'high', provenance: 'given', source: 'mover' },
      {
        question: 'reproduced',
        value: 'Exported 3 rows, got 2, on dev.220.',
        provenance: 'given',
        source: 'mover',
      },
      { question: 'route', value: 'issue', provenance: 'given', source: 'mover' },
    ]);
  });

  it('refuses a criterion that is not one, by name, before anything is written', async () => {
    const fb = await fileBug('The board forgets its sort');
    const refusals = await refused(
      on('POST', `/feedback/${fb}/triage`, {
        route: 'issue',
        answers: { criterion: 'REQ-77 BC-1', severity: 'low', reproduced: 'x' },
      }),
    );
    expect(refusals[0]).toMatchObject({
      code: 'FEEDBACK_CRITERION_INVALID',
      path: '/answers/criterion',
    });
    expect(await statusOf(fb)).toBe('new');
  });

  it('serves the checklist the triage is judged by, as the form, the agent input and where it stands', async () => {
    const fb = await fileBug('The board is slow');
    const [read] = (await ok(on('GET', `/feedback/${fb}/checklist`))).checklists as Doc[];
    if (!read) throw new Error('the checklist route served no checklist');
    expect(read.id).toBe('feedback_triage');
    expect((read.form.fields as Doc[]).map((f) => f.name)).toEqual([
      'kind',
      'requirement',
      'criterion',
      'severity',
      'reproduced',
      'route',
    ]);
    expect(Object.keys(read.input.properties).sort()).toEqual([
      'criterion',
      'reproduced',
      'severity',
    ]);
    expect((read.now.gaps as Doc[]).map((g) => g.question)).toEqual([
      'criterion',
      'severity',
      'reproduced',
      'route',
    ]);
  });
});

describe('a bug against an existing criterion is triaged with only its three answers (criterion 2)', () => {
  it('takes the issue route on the criterion’s requirement, and names the criterion on the item', async () => {
    const req = await agreedRequirement();
    const fb = await fileBug('A reload clears my filter');
    const out = (
      await ok(
        on('POST', `/feedback/${fb}/triage`, {
          answers: {
            criterion: `${req} BC-1`,
            severity: 'high',
            reproduced: 'Reload on dev.220 clears it.',
          },
        }),
      )
    ).feedback;
    expect(out.status).toBe('triaged');
    expect(out.route).toMatchObject({ route: 'issue' });
    const [issue] = (await db.execute(sql`
      SELECT i.requirement_id, r.req_seq FROM feedback_route_issues fr
        JOIN issues i ON i.id = fr.issue_id JOIN requirements r ON r.id = i.requirement_id
        JOIN feedback f ON f.id = fr.feedback_id
       WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(fb.slice(3))}
    `)) as unknown as Doc[];
    expect(`REQ-${issue?.req_seq}`, 'the filed issue delivers the criterion’s requirement').toBe(
      req,
    );
    const [named] = (await db.execute(sql`
      SELECT c.code FROM feedback f JOIN requirement_criteria c ON c.id = f.violated_criterion_id
       WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(fb.slice(3))}
    `)) as unknown as Doc[];
    expect(named?.code).toBe('BC-1');
  });

  it('refuses another route for it by name, and a criterion of another requirement', async () => {
    const req = await agreedRequirement();
    const fb = await fileBug('A reload clears my filter, again');
    const three = { criterion: `${req} BC-1`, severity: 'high', reproduced: 'Reload clears it.' };
    const [wrong] = await refused(
      on('POST', `/feedback/${fb}/triage`, {
        route: 'new_requirement',
        title: 'Filters',
        answers: three,
      }),
    );
    expect(wrong).toMatchObject({ code: 'FEEDBACK_ROUTE_TARGET_MISMATCH', path: '/route' });

    const other = await agreedRequirement();
    const about = await fileBug('The filter is lost', { requirement: other });
    const [misfit] = await refused(on('POST', `/feedback/${about}/triage`, { answers: three }));
    expect(misfit).toMatchObject({ code: 'FEEDBACK_CRITERION_INVALID' });
    expect(misfit?.detail).toContain(`is about ${other}`);
  });
});

describe('a suggestion accept meets the same check (criterion 3)', () => {
  const suggest = async (fb: string, payload: Doc) =>
    (
      await ok(
        on('POST', '/suggestions', {
          kind: 'feedback_triage',
          feedback: fb,
          baseRevision: null,
          payload,
        }),
        201,
      )
    ).suggestion.id as string;

  it('refuses the accept of a proposal with no answers, naming each question, and takes one that answers', async () => {
    const fb = await fileBug('Cards vanish on save');
    const bare = await suggest(fb, { route: 'issue', note: 'the save bug' });
    const refusals = await refused(
      on('POST', `/suggestions/${bare}/accept`, { reason: 'looks right' }),
    );
    expect(refusals.map((r) => r.path)).toEqual([
      '/answers/criterion',
      '/answers/severity',
      '/answers/reproduced',
    ]);
    expect(await statusOf(fb)).toBe('new');

    const answered = await suggest(fb, {
      route: 'issue',
      note: 'the save bug',
      answers: {
        criterion: 'none',
        severity: 'medium',
        reproduced: 'Saved twice on dev.220, both cards gone.',
      },
    });
    await ok(on('POST', `/suggestions/${answered}/accept`, { reason: 'looks right' }));
    expect(await statusOf(fb)).toBe('triaged');
  });
});

describe('loop close answers from the record (criterion 4)', () => {
  /** A bug routed to a closed issue that traces BC-1 of an agreed requirement, naming BC-1 violated. */
  async function resolvedAgainstBc1(seq: number) {
    const req = await agreedRequirement();
    const { id: issueId, key } = await createTestIssue(projectId, ownerId, seq, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await ok(on('POST', `/requirements/${req}/issues`, { issue: `ISS-${seq}` }));
    await ok(api(token, 'POST', `/api/issues/${issueId}/criteria/traces`, { codes: ['BC-1'] }));
    const fbId = await feedbackIdOf(await createTestFeedback(projectId, ownerId, seq, [issueId]));
    await db.execute(sql`
      UPDATE feedback SET violated_criterion_id = (
        SELECT c.id FROM requirement_criteria c JOIN requirements r ON r.id = c.requirement_id
         WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(req.slice(4))} AND c.code = 'BC-1')
       WHERE id = ${fbId}
    `);
    return { req, issueId, key, fbId, fb: `FB-${seq}` };
  }

  const feedbackIdOf = async (fb: string) =>
    (
      (await db.execute(sql`
      SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(fb.slice(3))}
    `)) as unknown as { id: string }[]
    )[0]?.id as string;

  const pass = (issueId: string, sha = FIXED) =>
    ok(
      api(token, 'POST', `/api/issues/${issueId}/verdicts`, {
        criterion: 1,
        verdict: 'pass',
        reason: 'pass on the running build',
        identity: { kind: 'commit', sha },
        evidence: ['shot.png'],
      }),
    );

  /** Seen resolved by one sweep, then aged past its window; the caller runs the sweep that answers. */
  async function agedPastWindow(fbId: string) {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    await sweepResolvedFeedback();
    await db.execute(
      sql`UPDATE feedback SET resolved_seen_at = now() - interval '8 days' WHERE id = ${fbId}`,
    );
    return sweepResolvedFeedback;
  }

  const pastWindow = async (fbId: string) => (await agedPastWindow(fbId))();

  it('verifies where the violated criterion passes on the running build, naming its sources', async () => {
    unplant = plantLiveBuild(LIVE, { [FIXED]: true });
    const { req, issueId, fbId, fb } = await resolvedAgainstBc1(41);
    await pass(issueId);
    const swept = await pastWindow(fbId);
    expect(swept).toMatchObject({ verified: 1, held: 0 });
    const out = (await ok(on('GET', `/feedback/${fb}`))).feedback;
    expect(out.status).toBe('verified');
    expect(out.verified.reason).toMatch(
      new RegExp(
        `^Verified from the record: ${req} BC-1 passes on the running build, and nothing was filed against it since \\d{4}-\\d{2}-\\d{2}\\.$`,
      ),
    );
  });

  it('leaves it resolved for a person where the criterion is not proven on the running build', async () => {
    unplant = plantLiveBuild(LIVE, { [UNSHIPPED]: false });
    const { issueId, fbId, fb } = await resolvedAgainstBc1(42);
    await pass(issueId, UNSHIPPED);
    expect(await pastWindow(fbId)).toMatchObject({ verified: 0, held: 1 });
    expect(await statusOf(fb)).toBe('triaged');
  });

  it('leaves it resolved where feedback about the requirement arrived since, or no criterion was named', async () => {
    unplant = plantLiveBuild(LIVE, { [FIXED]: true });
    const { req, issueId, fbId, fb } = await resolvedAgainstBc1(43);
    await pass(issueId);
    const sweepResolvedFeedback = await agedPastWindow(fbId);
    await fileBug('The filter is gone again', { requirement: req });
    expect(await sweepResolvedFeedback()).toMatchObject({ verified: 0, held: 1 });
    expect(await statusOf(fb)).toBe('triaged');

    const plain = await createTestIssue(projectId, ownerId, 60, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const unnamed = await feedbackIdOf(
      await createTestFeedback(projectId, ownerId, 60, [plain.id]),
    );
    expect((await pastWindow(unnamed)).verified).toBe(0);
    expect(await statusOf('FB-60')).toBe('triaged');
  });
});
