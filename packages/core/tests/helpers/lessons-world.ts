// The world the lessons e2e files share (REQ-50): the app on a throwaway Postgres, a project with an
// owner, a member and a viewer, two requirement areas and its steward account; corrections kept
// directly; the steward's lessons pass with the test's own model answers; and the store reads the
// cases assert, since no route reads a lesson for a screen (BC-9).

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  closeWorld,
  type Doc,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from './ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from './factories.js';

export type Who = 'owner' | 'member' | 'viewer';

/** What the world holds once it is open; read through it, never copied before `beforeAll` ran. */
export const w = {
  say: (async () => {
    throw new Error('lessons-world: the world is not open');
  }) as (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>,
  projectId: '',
  ownerId: '',
  stewardId: '',
  areaA: '',
  areaB: '',
};

export const say = (who: Who, method: string, path: string, body?: unknown) =>
  w.say(who, method, path, body);
export const at = (path: string, project = w.projectId) => `/api/projects/${project}${path}`;
export const codes = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

export async function correction(
  reason: string,
  over: { areaId?: string | null; at?: Date; project?: string; source?: string } = {},
) {
  const { db } = await import('../../src/db/client.js');
  const { recordCorrection } = await import('../../src/lessons/index.js');
  const id = await db.transaction((tx) =>
    recordCorrection(tx, {
      projectId: over.project ?? w.projectId,
      source: (over.source ?? 'suggestion_rejected') as 'suggestion_rejected',
      sourceRef: randomUUID(),
      item: { kind: 'suggestion', id: randomUUID(), key: 'REQ-1' },
      areaId: over.areaId ?? null,
      reason,
      by: { userId: w.ownerId, agency: 'human' },
      ...(over.at ? { at: over.at } : {}),
    }),
  );
  if (!id) throw new Error('the correction was not kept');
  return id;
}

/** A review or settlement the test answers: a fixed one, or one read from what was asked. */
type Answer<I, O> = O | null | ((input: I) => O | null);
const answerOf = <I, O>(a: Answer<I, O> | undefined, input: I): O | null =>
  typeof a === 'function' ? (a as (input: I) => O | null)(input) : (a ?? null);

/**
 * The steward's pass with the test's own model answers: link and propose exactly what is asked, and
 * review each proposal and settle each confusion as `review` and `settle` say. Left out, neither
 * gives an answer, so what waits stays waiting.
 */
export async function pass(answer: {
  links?: { correction: string; lesson: number }[];
  proposals?: Doc[];
  review?: Answer<Doc, Doc>;
  settle?: Answer<Doc, Doc>;
  now?: Date;
  /** The project the pass runs over: the world's own unless a case opened one of its own. */
  project?: string;
}) {
  const { runLessonsPass } = await import('../../src/steward/lessons-pass.js');
  const tally = await runLessonsPass({
    projectIds: [answer.project ?? w.projectId],
    ...(answer.now ? { now: answer.now } : {}),
    group: async () => ({
      links: answer.links ?? [],
      proposals: (answer.proposals ?? []) as never,
    }),
    review: async (_p, input) => answerOf(answer.review, input as never) as never,
    settle: async (_p, input) => answerOf(answer.settle, input as never) as never,
  });
  expect(tally.failed, 'a lessons pass failed on the project').toBe(0);
  return tally;
}

/** The steward's answers, as the model would give them. */
export const approve = (reason = 'It says what the corrections meant.') => ({
  verdict: 'approve',
  sentence: null,
  scope: null,
  areaId: null,
  itemKind: null,
  reason,
});
export const settled = (
  resolution: 'keep' | 'edit' | 'retire',
  reason: string,
  sentence?: string,
) => ({
  resolution,
  sentence: sentence ?? null,
  reason,
});

/** One lesson as the store holds it, with its corrections, applications and confusions. */
export async function lesson(
  n: number,
  project = w.projectId,
): Promise<Doc & { corrections: Doc[]; applications: Doc[]; confusions: Doc[] }> {
  const [row] = await rows<Doc>(sql`
    SELECT l.id, l.number, l.sentence, l.status, l.scope_kind, l.scope_item_kind, l.proposed_by,
           l.decided_reason, l.applied_count, l.check_issue_id, s.number AS superseded_by
    FROM lessons l LEFT JOIN lessons s ON s.id = l.superseded_by_id
    WHERE l.project_id = ${project} AND l.number = ${n}`);
  if (!row) throw new Error(`lessons-world: no L-${n}`);
  const [corrections, applications, confusions] = await Promise.all([
    rows<Doc>(
      sql`SELECT id, said_at FROM corrections WHERE lesson_id = ${row.id} ORDER BY said_at`,
    ),
    rows<Doc>(
      sql`SELECT id, output_kind, output_ref, wrong_at, wrong_reason FROM lesson_applications WHERE lesson_id = ${row.id} ORDER BY at`,
    ),
    rows<Doc>(
      sql`SELECT id, kind, decided_at, decided_by, resolution, application_id FROM lesson_confusions WHERE lesson_id = ${row.id} ORDER BY raised_at`,
    ),
  ]);
  return { ...row, corrections, applications, confusions };
}

/** The reasons the kernel kept for a lesson's moves, oldest first. */
export const moves = async (id: string) =>
  rows<{ to_status: string; reason: string | null; actor_id: string | null }>(sql`
    SELECT to_status, reason, actor_id FROM kernel_transitions
    WHERE entity = 'lesson' AND entity_id = ${id} ORDER BY created_at`);

/** The number of the lesson whose sentence this is. */
export async function numberOf(sentence: string): Promise<number> {
  const [row] = await rows<{ number: number }>(
    sql`SELECT number FROM lessons WHERE project_id = ${w.projectId} AND sentence = ${sentence}`,
  );
  if (!row) throw new Error(`lessons-world: no lesson reads "${sentence}"`);
  return row.number;
}

export const proposal = (
  sentence: string,
  corrections: string[],
  scope: Doc = { scope: 'project', areaId: null, itemKind: null },
  supersedes: number | null = null,
) => ({ sentence, corrections, ...scope, supersedes });

/** An approved lesson: proposed by the steward from two corrections, approved by its review. */
export async function approved(sentence: string, scope?: Doc): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  await pass({
    proposals: [proposal(sentence, [a, b], scope)],
    review: (input) => ((input.lesson as Doc).sentence === sentence ? approve() : null),
  });
  return numberOf(sentence);
}

/** A lesson the steward proposed from one correction and has not reviewed: never applied. */
export async function proposed(sentence: string, project = w.projectId): Promise<number> {
  const one = await correction(`${sentence} (said once)`, { project });
  const { proposeLesson } = await import('../../src/lessons/index.js');
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const made = await proposeLesson({
    projectId: project,
    actor: { userId: await stewardAccountOf(project), agency: 'agent' },
    body: { sentence, scope: { kind: 'project' }, corrections: [one] },
  });
  return Number(made.key.slice(2));
}

/** A project of the case's own, owned by the world's owner: nothing another case left waits in it. */
export async function ownProject(): Promise<{ id: string; stewardId: string }> {
  const id = (await createTestProject(w.ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  return { id, stewardId: await stewardAccountOf(id) };
}

/** The lessons block a prompt for this audience carries, empty where none reaches it. */
export async function block(audience: { produces: string[]; area: string | null | 'any' }) {
  const { lessonsBlockFor } = await import('../../src/lessons/index.js');
  return (await lessonsBlockFor(w.projectId, { ...audience, raise: 'test' } as never, 2)) ?? '';
}

/** Opens the world before the file's cases and closes it after them. */
export function openLessonsWorld(): void {
  beforeAll(async () => {
    testEnv();
    const { app } = await import('../../src/index.js');
    await startQueue();
    const { signUserToken } = await import('../../src/credentials/jwt.js');
    w.ownerId = (await createTestUser({ verified: true })).id;
    const memberId = (await createTestUser({ verified: true })).id;
    const viewerId = (await createTestUser({ verified: true })).id;
    w.projectId = (await createTestProject(w.ownerId)).id;
    await addProjectMember(w.projectId, memberId, 'member');
    await addProjectMember(w.projectId, viewerId, 'viewer');
    const { stewardAccountOf } = await import('../../src/steward/account.js');
    w.stewardId = await stewardAccountOf(w.projectId);
    [w.areaA, w.areaB] = (
      await rows<{ id: string }>(sql`
        INSERT INTO requirement_areas (project_id, name) VALUES (${w.projectId}, 'Billing'), (${w.projectId}, 'Wards')
        RETURNING id`)
    ).map((r) => r.id) as [string, string];
    w.say = requester(app, {
      owner: await signUserToken(w.ownerId),
      member: await signUserToken(memberId),
      viewer: await signUserToken(viewerId),
    });
  }, 120_000);
  afterAll(async () => {
    await closeWorld();
  });
}
