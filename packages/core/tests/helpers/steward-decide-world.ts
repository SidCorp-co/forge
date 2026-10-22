// The world the steward's decision tests share (REQ-48 BC-5): one project, its owner, a reporter, the
// steward account with a stuck-diagnosis token, a scripted standing read the case states, and one
// diagnosis turn whose only call is `steward_decide` about the item. A test file using it mocks the
// chat with `scripted-chat.ts` itself, since a mock is hoisted per file.

import type { Said } from '@forge/contracts/said';
import type { ItemStanding } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { type Doc, ok, type Reply, requester, startQueue, testEnv } from './ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from './factories.js';
import { resetScript, script } from './scripted-chat.js';

export type Subject = { kind: 'issue' | 'requirement' | 'feedback'; id: string; key: string };
type Who = 'owner' | 'steward' | 'reporter';

export const world = {
  say: (async () => {
    throw new Error('startStewardDecideWorld has not run');
  }) as (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>,
  projectId: '',
  ownerId: '',
  reporterId: '',
  stewardId: '',
  /** The standing read the steward's doors see, as each case states it. */
  standings: [] as ItemStanding[],
  /** The run the last diagnosis wrote. */
  lastRunId: '',
};

export const at = (path: string) => `/api/projects/${world.projectId}${path}`;
export const as = (method: string, path: string, body?: unknown) =>
  world.say('owner', method, at(path), body);

const said = (key: string) => ({ key }) as unknown as Said;

/** A stuck standing of the subject, waiting on `act` (a said key), as the steward's read gives it. */
export function stuck(subject: Subject, act: string): ItemStanding {
  const since = '2026-10-01T00:00:00.000Z';
  return {
    subject,
    title: subject.key,
    group: 'stuck',
    waitingOn: {
      kind: 'person',
      who: 'A holder',
      act,
      rule: 'overdue',
      ref: null,
      dueAt: null,
      says: { who: said('standing.who.you'), act: said(act), rule: said('overdue') },
    },
    note: null,
    actClass: 'person_decide',
    since,
    dueAt: null,
    stuck: {
      code: 'overdue',
      since,
      reason: `${subject.key} is past its due and nobody acted`,
      via: null,
      says: { reason: said('overdue') },
    },
    carriedBy: null,
    basis: `basis-${subject.key}`,
  };
}

export const reqId = async (key: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${world.projectId} AND req_seq = ${Number(key.slice(4))}`,
    )
  )[0]?.id ?? '';

export const fbId = async (key: string) =>
  (
    await rows<{ id: string }>(
      sql`SELECT id FROM feedback WHERE project_id = ${world.projectId} AND fb_seq = ${Number(key.slice(3))}`,
    )
  )[0]?.id ?? '';

/** A draft requirement at r1, written through its own door. */
export async function draftRequirement(
  title: string,
  spec: Doc = {},
  criteria = [{ body: `${title} works end to end.` }],
): Promise<Subject> {
  const key = ok(
    await as('POST', '/requirements', { title, reason: 'asked once', spec, criteria }),
    201,
  ).key as string;
  return { kind: 'requirement', id: await reqId(key), key };
}

/** A requirement agreed at r1. */
export async function agreedRequirement(
  title: string,
  spec: Doc,
  criteria: { body: string }[],
): Promise<Subject> {
  const req = await draftRequirement(title, spec, criteria);
  await makeAgreeReady(world.projectId, Number(req.key.slice(4)), world.ownerId);
  ok(await as('POST', `/requirements/${req.key}/revisions/1/propose`, {}));
  ok(await as('POST', `/requirements/${req.key}/revisions/1/accept`, { reason: 'ok' }));
  ok(await as('POST', `/requirements/${req.key}/agree`, { revision: 1, reason: 'ok' }));
  return req;
}

/** An issue at `status`, titled, with a description a merge carries. */
export async function issueAt(seq: number, title: string, status: string): Promise<Subject> {
  const issue = await createTestIssue(world.projectId, world.ownerId, seq, {
    status: status as never,
    createdAt: new Date(Date.now() - 9 * 86_400_000),
    ...(status === 'closed' ? { mergedAt: new Date() } : {}),
  });
  await db.execute(sql`
    UPDATE issues SET title = ${title}, description = ${`What ${title} means, in the reporter's words.`}
     WHERE id = ${issue.id}`);
  return { kind: 'issue', id: issue.id, key: issue.key };
}

/** The newest question on the subject: on the issue or requirement, or about the feedback item. */
export async function questionOn(s: Subject) {
  const where =
    s.kind === 'issue'
      ? sql`q.issue_id = ${s.id}`
      : s.kind === 'requirement'
        ? sql`q.requirement_id = ${s.id}`
        : sql`q.about ->> 'feedbackId' = ${s.id}`;
  const [q] = await rows<{ id: string; status: string; feedback_id: string | null; last: Doc }>(sql`
    SELECT q.id, q.status, q.feedback_id, q.steps -> -1 AS last FROM agent_questions q
     WHERE ${where} ORDER BY q.created_at DESC LIMIT 1`);
  return q;
}

export const answer = (questionId: string, body: Record<string, unknown>) =>
  world.say('owner', 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

/** The viewer's Needs you decision on the item, by its key or the key it opens. */
export const decisionOf = async (key: string) =>
  ((ok(await as('GET', '/needs-you/decisions')).decisions as Doc[]) ?? []).find(
    (d) => d.key === key || (d.opens as Doc | null)?.key === key,
  );

export const lastMove = async (entity: 'issue' | 'requirement', id: string) =>
  (
    await rows<{ to_status: string; reason: string | null }>(sql`
      SELECT to_status, reason FROM kernel_transitions
       WHERE entity = ${entity} AND entity_id = ${id} ORDER BY created_at DESC LIMIT 1`)
  )[0];

export const optionIds = (q: { last: Doc } | undefined) =>
  ((q?.last.options as Doc[]) ?? []).map((o) => o.id);

/** Run one stuck diagnosis on `subject` whose one call is `steward_decide`; each tool's answer. */
export async function diagnose(subject: Subject, args: Record<string, unknown>): Promise<string> {
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  const [made] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              state, not_before, started_at, ended_at)
    VALUES (${world.projectId}, ${subject.kind}, ${subject.id}, ${subject.key}, 'standing.stuck', '[]'::jsonb,
            ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
    RETURNING id`);
  world.lastRunId = made?.id ?? '';
  const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, world.lastRunId));
  if (!run) throw new Error('the run row was not written');
  resetScript();
  script.steps = [
    { tool: { name: 'steward_decide', args: { about: subject.key, ...args } } },
    { text: 'Asked.' },
  ];
  await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId: world.stewardId });
  return JSON.stringify(
    (script.sent.at(-1) ?? []).filter((m) => m.role === 'tool').map((m) => m.content),
  );
}

/** Boot the app with the scripted standing read, and make the project, its people and the steward. */
export async function startStewardDecideWorld(): Promise<void> {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === world.projectId ? world.standings : []));
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.reporterId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  world.stewardId = await stewardAccountOf(world.projectId);
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  const steward = (
    await mintStewardCredential({
      projectId: world.projectId,
      stewardId: world.stewardId,
      acts: ['stuck_diagnosis'],
      ttlMs: 600_000,
    })
  ).token;
  world.say = requester(app, {
    owner: await signUserToken(world.ownerId),
    reporter: await signUserToken(world.reporterId),
    steward,
  });
}
