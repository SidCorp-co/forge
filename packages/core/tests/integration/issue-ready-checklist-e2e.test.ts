/**
 * REQ-34 r2 BC-1, BC-2, BC-3, BC-9, BC-18, BC-24 through the issue machine's draft → open edge, which
 * names the issue-ready checklist (`@forge/contracts/checklist-registry:ISSUE_READY_CHECKLIST`): the
 * kernel judges it whatever door the move came through — a person's session (the web), a personal
 * access token (the API), an agent's token (the agent's tool, which calls the same route), and a
 * box's own move (a lane run) — and records how each move stood.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { applyStatusTransition } from '../../src/issues/apply-transition.js';
import { isRefusal } from '../../src/lib/refusal.js';
import { type ApiResponse, api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createReadyDraftIssue,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let agentId: string;
let deviceId: string;
let doors: Record<'web' | 'api' | 'agent', string>;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  agentId = (await createTestUser({ kind: 'agent' })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await addProjectMember(projectId, agentId, 'admin');
  deviceId = await createTestDevice(ownerId);
  doors = {
    web: await userToken(ownerId),
    api: await patToken(ownerId, [projectId]),
    agent: await patToken(agentId, [projectId]),
  };
});

let seq = 0;
async function draftIssue(over: { requirementId?: string; plannedRevision?: number } = {}) {
  const id = randomUUID();
  seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, requirement_id, planned_revision)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'draft', ${ownerId},
            ${over.requirementId ?? null}, ${over.plannedRevision ?? null})
  `);
  return id;
}

/** A draft its record completes, against REQ-1 agreed at revision 1. */
async function readyIssue(): Promise<string> {
  seq += 1;
  return (await createReadyDraftIssue(projectId, ownerId, seq, 1)).id;
}

const moveThrough = (door: keyof typeof doors, id: string, body: Record<string, unknown>) =>
  api(doors[door], 'POST', `/api/issues/${id}/transition`, body);

/** A box's own move, as a lane run makes it: the device actor, no HTTP door. */
async function moveAsLane(id: string, answers?: unknown): Promise<ApiResponse['body']> {
  try {
    await applyStatusTransition(
      { id, projectId, status: 'draft', reopenCount: 0 },
      'open',
      { id: deviceId, ownerId },
      answers === undefined ? {} : { answers },
    );
    return { moved: true };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return { error: { code: err.fallbackCode, refusals: err.refusals } };
  }
}

type Row = {
  code: string;
  path: string;
  detail: string;
  question?: string | undefined;
  field?: string | undefined;
};
const refusalsOf = (body: ApiResponse['body']): Row[] =>
  ((body.error as { refusals?: Row[] } | undefined)?.refusals ?? []).map(
    ({ code, path, detail, question, field }) => ({ code, path, detail, question, field }),
  );

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return String(row?.status);
}

describe('an incomplete issue-ready checklist', () => {
  it('is refused alike through the web, the API, the agent and a lane run, naming each blocking question on its field', async () => {
    const id = await draftIssue();
    const seen: Record<string, Row[]> = {};
    for (const door of ['web', 'api', 'agent'] as const) {
      const res = await moveThrough(door, id, { toStatus: 'open' });
      expect(res.status, `${door}: ${JSON.stringify(res.body)}`).toBe(422);
      seen[door] = refusalsOf(res.body);
    }
    seen.lane = refusalsOf(await moveAsLane(id));

    const expected: Row[] = [
      {
        code: 'CHECKLIST_INCOMPLETE',
        path: '/answers/requirement',
        question: 'requirement',
        field: 'requirementId',
        detail:
          'Which agreed requirement does this issue deliver, and at which revision? This issue names no requirement. Link the issue to the agreed or accepted requirement it delivers, at the revision its plan is written against.',
      },
      {
        code: 'CHECKLIST_INCOMPLETE',
        path: '/answers/criteria',
        question: 'criteria',
        field: 'acceptanceCriteria',
        detail:
          "What are its criteria, each traced to a business criterion of that revision? This issue has no criteria. Write the issue's numbered criteria and trace each one to a BC that stands at the revision it plans against.",
      },
    ];
    for (const door of ['web', 'api', 'agent', 'lane']) expect(seen[door], door).toEqual(expected);
    expect(await statusOf(id)).toBe('draft');

    const refused = await rows<{
      actor_agency: string;
      checklist: string;
      checklist_version: number;
      n: number;
    }>(sql`
      SELECT actor_agency, checklist, checklist_version, jsonb_array_length(refusals) AS n
        FROM kernel_refused_moves WHERE entity = 'issue' AND entity_id = ${id} ORDER BY created_at
    `);
    expect(refused).toEqual([
      { actor_agency: 'human', checklist: 'issue_ready', checklist_version: 1, n: 2 },
      { actor_agency: 'human', checklist: 'issue_ready', checklist_version: 1, n: 2 },
      { actor_agency: 'agent', checklist: 'issue_ready', checklist_version: 1, n: 2 },
      { actor_agency: 'agent', checklist: 'issue_ready', checklist_version: 1, n: 2 },
    ]);
  });

  it('names a criterion that traces no BC of the planned revision', async () => {
    const id = await readyIssue();
    await db.execute(sql`
      INSERT INTO issue_criteria (issue_id, n, statement, position) VALUES (${id}, 2, 'untraced', 1)
    `);
    const res = await moveThrough('web', id, { toStatus: 'open' });
    expect(refusalsOf(res.body).map((r) => r.detail)).toEqual([
      "What are its criteria, each traced to a business criterion of that revision? Criteria 2 trace to no BC that stands at REQ-1 revision 1. Write the issue's numbered criteria and trace each one to a BC that stands at the revision it plans against.",
    ]);
  });
});

describe('a complete issue-ready checklist', () => {
  it('opens the issue, taking the hotfix question as assumed, and records the checklist on the move', async () => {
    const id = await readyIssue();
    const res = await moveThrough('web', id, { toStatus: 'open' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('open');

    const [move] = await rows<{
      checklist: string;
      checklist_version: number;
      checklist_answers: unknown;
    }>(sql`
      SELECT checklist, checklist_version, checklist_answers FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${id} AND to_status = 'open'
    `);
    expect(move).toEqual({
      checklist: 'issue_ready',
      checklist_version: 1,
      checklist_answers: [
        {
          question: 'requirement',
          value: 'REQ-1 at revision 1',
          provenance: 'given',
          source: 'record:requirementId',
        },
        {
          question: 'criteria',
          value: '1 criteria, tracing BC-1 of REQ-1 revision 1',
          provenance: 'given',
          source: 'record:acceptanceCriteria',
        },
        {
          question: 'design',
          value: 'None: it builds no workflow design.',
          provenance: 'given',
          source: 'record:buildsWorkflow',
        },
        {
          question: 'hotfix',
          value: 'Not a hotfix: it fixes no production failure.',
          provenance: 'assumed',
          source: 'recommended',
          open: '0769f177-2941-42db-81a6-5346b00252bb',
        },
      ],
    });
  });

  it("records the mover's own answer as given", async () => {
    const id = await readyIssue();
    const body = await moveAsLane(id, { hotfix: 'Fixes FB-3, restoring BC-1.' });
    expect(body).toEqual({ moved: true });
    const [move] = await rows<{ checklist_answers: Array<{ question: string }> }>(sql`
      SELECT checklist_answers FROM kernel_transitions WHERE entity_id = ${id} AND to_status = 'open'
    `);
    expect(move?.checklist_answers.find((a) => a.question === 'hotfix')).toEqual({
      question: 'hotfix',
      value: 'Fixes FB-3, restoring BC-1.',
      provenance: 'given',
      source: 'mover',
    });
  });
});

describe('a wrong answer is refused by name at every door', () => {
  it('an answer the record owns, through the API and a lane run alike', async () => {
    const id = await readyIssue();
    const res = await moveThrough('api', id, {
      toStatus: 'open',
      answers: { requirement: 'REQ-9' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    const lane = refusalsOf(await moveAsLane(id, { requirement: 'REQ-9' }));
    expect(refusalsOf(res.body)).toEqual(lane);
    expect(lane).toEqual([
      expect.objectContaining({
        code: 'CHECKLIST_ANSWER_INVALID',
        path: '/answers/requirement',
        field: 'requirementId',
      }),
    ]);
    expect(await statusOf(id)).toBe('draft');
  });

  it('answers sent to a move that asks no checklist', async () => {
    const id = await readyIssue();
    await moveThrough('web', id, { toStatus: 'open' });
    const res = await moveThrough('web', id, {
      toStatus: 'on_hold',
      reason: 'later',
      answers: { hotfix: 'no' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalsOf(res.body)).toEqual([
      expect.objectContaining({ code: 'CHECKLIST_ANSWER_INVALID', path: '/answers' }),
    ]);
  });
});

describe('GET /api/issues/:id/checklist', () => {
  it('serves the form and the agent input from the definition, how the issue stands now, and each gated move', async () => {
    const id = await readyIssue();
    await db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source)
      VALUES ('issue', ${id}, 'draft', 'open', 'user', 'human', ${ownerId}, 'issues')
    `);
    await withKernelMarker(db, (tx) =>
      tx.execute(sql`UPDATE issues SET status = 'draft' WHERE id = ${id}`),
    );
    await moveThrough('web', id, { toStatus: 'open' });

    const res = await api(doors.web, 'GET', `/api/issues/${id}/checklist`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [checklist] = res.body.checklists as Array<{
      id: string;
      form: { fields: Array<{ name: string }> };
      input: { properties: Record<string, unknown> };
      now: { complete: boolean };
      moves: Array<{ standing: string; countsAsPassed: boolean; checklist: unknown }>;
    }>;
    expect(checklist?.id).toBe('issue_ready');
    expect(checklist?.form.fields.map((f) => f.name)).toEqual([
      'requirement',
      'criteria',
      'design',
      'hotfix',
    ]);
    expect(Object.keys(checklist?.input.properties ?? {})).toEqual(['hotfix']);
    expect(checklist?.now.complete).toBe(true);
    expect(checklist?.moves.map((m) => [m.standing, m.countsAsPassed])).toEqual([
      ['passed', true],
      ['no_checklist', false],
    ]);
  });
});
