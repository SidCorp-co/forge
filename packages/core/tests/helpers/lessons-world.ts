// The world the lessons e2e files share (REQ-50): the app on a throwaway Postgres, a project with an
// owner, a member and a viewer, two requirement areas and its steward account; corrections kept
// directly; the steward's lessons pass with the test's own grouping; and the reads the cases assert.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
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

/** The steward's pass with the test's own grouping: link and propose exactly what is asked. */
export async function pass(answer: {
  links?: { correction: string; lesson: number }[];
  proposals?: Doc[];
}) {
  const { runLessonsPass } = await import('../../src/steward/lessons-pass.js');
  const tally = await runLessonsPass({
    projectIds: [w.projectId],
    group: async () => ({
      links: answer.links ?? [],
      proposals: (answer.proposals ?? []) as never,
    }),
  });
  expect(tally.failed, 'a lessons pass failed on the project').toBe(0);
  return tally;
}

export const lesson = async (n: number) =>
  ok(await say('owner', 'GET', at(`/lessons/${n}`))).lesson as Doc;

export const proposal = (
  sentence: string,
  corrections: string[],
  scope: Doc = { scope: 'project', areaId: null, itemKind: null },
) => ({ sentence, corrections, ...scope });

/** An approved lesson, proposed by the steward from two corrections. */
export async function approved(sentence: string, scope?: Doc): Promise<number> {
  const a = await correction(`${sentence} (1)`);
  const b = await correction(`${sentence} (2)`);
  await pass({ proposals: [proposal(sentence, [a, b], scope)] });
  const list = ok(await say('owner', 'GET', at('/lessons'))).lessons as Doc[];
  const n = list.find((l) => l.sentence === sentence)?.number as number;
  ok(await say('owner', 'POST', at(`/lessons/${n}/approve`), {}));
  return n;
}

/** A lesson a member proposed by hand from one correction: never approved, so never applied. */
export async function proposed(sentence: string): Promise<Doc> {
  const one = await correction(`${sentence} (said once)`);
  const body = { sentence, scope: { kind: 'project' }, corrections: [one] };
  return ok(await say('member', 'POST', at('/lessons'), body), 201).lesson as Doc;
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
