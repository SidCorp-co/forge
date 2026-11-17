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
  settleOutbox,
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
 * The steward's pass with the test's own model answers: reject, link and propose exactly what is
 * asked, and review each proposal and settle each confusion as `review` and `settle` say. Left out,
 * neither gives an answer, so what waits stays waiting. `seen` is handed what the grouping was asked.
 */
export async function pass(answer: {
  links?: { correction: string; lesson: number }[];
  proposals?: Doc[];
  rejections?: { correction: string; reason: string }[];
  seen?: (input: { corrections: Doc[]; lessons: Doc[] }) => void;
  review?: Answer<Doc, Doc>;
  settle?: Answer<Doc, Doc>;
  /** What the steward says a lesson owed a check is about, where its record does not say. */
  classify?: Answer<Doc, Doc>;
  /** The lifecycle steps' answers (ISS-1251): an anchor owed, a re-check, a fold, and a replay. */
  anchor?: Answer<Doc, Doc>;
  recheck?: Answer<Doc, Doc>;
  fold?: Answer<Doc, Doc>;
  replay?: Answer<Doc, Doc>;
  /** The merges the steward proposes over a pile past its cap, read from the pile and its entries. */
  merge?: Answer<Doc, Doc[]>;
  now?: Date;
  /** The project the pass runs over: the world's own unless a case opened one of its own. */
  project?: string;
}) {
  const { runLessonsPass } = await import('../../src/steward/lessons-pass.js');
  const tally = await runLessonsPass({
    projectIds: [answer.project ?? w.projectId],
    ...(answer.now ? { now: answer.now } : {}),
    group: async (_p, input) => {
      answer.seen?.(input as never);
      return {
        rejections: answer.rejections ?? [],
        links: answer.links ?? [],
        proposals: (answer.proposals ?? []) as never,
      };
    },
    review: async (_p, input) => answerOf(answer.review, input as never) as never,
    settle: async (_p, input) => answerOf(answer.settle, input as never) as never,
    classify: async (_p, input) => answerOf(answer.classify, input as never) as never,
    // the lifecycle steps answer nothing unless a case gives their answers, and a replay adopts by
    // default, fixing every failure it is shown, so a case about something else is never held by it
    anchor: async (_p, l) => answerOf(answer.anchor, l as never) as never,
    recheck: async (_p, l) => answerOf(answer.recheck, l as never) as never,
    fold: async (_p, l) => answerOf(answer.fold, l as never) as never,
    replay: async (_p, input) =>
      (answer.replay
        ? answerOf(answer.replay, input as never)
        : {
            fixed: input.failures.length,
            broken: [],
            reason: 'It fixes what it came from.',
          }) as never,
    merge: async (_p, pile, entries) => answerOf(answer.merge, { pile, entries } as never) as never,
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
    SELECT l.id, l.number, l.sentence, l.status, l.scope_kind, l.scope_item_kind, l.about, l.proposed_by,
           l.decided_reason, l.applied_count, l.check_issue_id, l.routed_feedback_id,
           s.number AS superseded_by
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
      sql`SELECT id, kind, decided_at, decided_by, resolution, reason, application_id FROM lesson_confusions WHERE lesson_id = ${row.id} ORDER BY raised_at`,
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

/** A proposal the grouping answers; it says it is about a process unless `scope` says otherwise. */
/** The anchor a test's lesson names unless the case names its own: code no landing in a test touches. */
export const TEST_ANCHOR = 'packages/core/src/lessons/decide.ts:proposeLesson';

export const proposal = (
  sentence: string,
  corrections: string[],
  scope: Doc = { scope: 'project', areaId: null, itemKind: null },
  supersedes: number | null = null,
) => ({
  sentence,
  corrections,
  about: 'process',
  anchor: TEST_ANCHOR,
  ...scope,
  supersedes,
});

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
    body: {
      sentence,
      scope: { kind: 'project' },
      about: 'process',
      anchor: TEST_ANCHOR,
      corrections: [one],
    },
  });
  return Number(made.key.slice(2));
}

/** A project of the case's own, owned by the world's owner: nothing another case left waits in it. */
export async function ownProject(): Promise<{ id: string; stewardId: string }> {
  const id = (await createTestProject(w.ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  return { id, stewardId: await stewardAccountOf(id) };
}

/**
 * What an agent of this audience learns: the lessons map its prompt carries, then each lesson the map
 * names as the agent retrieves it, through the project's knowledge door: `L-<n> [<when>]: sentence`,
 * labelled with the situation the map's line gives it.
 * Empty where no lesson reaches it.
 */
export async function block(audience: { produces: string[]; area: string | null | 'any' }) {
  const { lessonsMapFor } = await import('../../src/lessons/index.js');
  const doors = { fetch: 'the read door', list: 'the list door', raise: 'test' };
  const map = (await lessonsMapFor(w.projectId, { ...audience, ...doors } as never, 2)) ?? '';
  const read: string[] = [];
  for (const [, slug, n, label] of map.matchAll(/^(lesson-(\d+)), when ([^:\n]+): /gm)) {
    const got = await say('member', 'GET', at(`/knowledge/${slug}`));
    if (got.status !== 200) throw new Error(`${slug} is named and not readable: ${got.status}`);
    read.push(`L-${n} [${label}]: ${got.json.body}`);
  }
  return [map, ...read].join('\n');
}

/**
 * An issue landed with its commit's paths, as the box reports them, those it read as reformatted
 * alone marked `formatOnly` (ISS-1251); its id.
 */
export async function landed(seq: number, paths: string[], reformatted: string[] = []) {
  const issueId = randomUUID();
  const commit = 'abc1234def5678abc1234def5678abc1234def56';
  const changes = paths.map((path) => ({
    path,
    change: 'changed',
    ...(reformatted.includes(path) ? { formatOnly: true } : {}),
  }));
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_paths)
    VALUES (${issueId}, ${w.projectId}, ${seq}, 'widget rework', 'awaiting_release', ${w.ownerId}, now(),
            ${commit}, ${JSON.stringify({ commit, read: 'box', changes })}::jsonb)`);
  return issueId;
}

/** The kernel's word that the issue's landing was taken past `awaiting_release`, delivered to every consumer. */
export async function landedMove(issueId: string) {
  const { db } = await import('../../src/db/client.js');
  const { emitEvent } = await import('../../src/outbox/index.js');
  await emitEvent(db, 'issue.transitioned', {
    entity: 'issue',
    id: issueId,
    projectId: w.projectId,
    issueId,
    from: 'awaiting_release',
    to: 'closed',
    machineVersion: 1,
    reason: null,
    actor: { type: 'user', id: w.ownerId, agency: 'agent' },
    at: new Date().toISOString(),
  });
  await settleOutbox(15_000);
}

/** A lesson's standing and its invalid mark, read off its row. */
export async function lessonState(n: number) {
  const [row] = await rows<{ status: string; invalid_at: Date | null; invalid_by: string | null }>(
    sql`SELECT status, invalid_at, invalid_by FROM lessons WHERE project_id = ${w.projectId} AND number = ${n}`,
  );
  return row;
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
