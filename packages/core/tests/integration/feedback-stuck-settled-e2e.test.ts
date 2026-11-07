/**
 * Feedback's Stuck group holds work nobody moves, never work that is settled (ISS-1072). An item that
 * reads resolved has shipped its answer or its fix and owes only a confirm, so it keeps its wait but
 * falls due by no clock; an item every report of which came from a project since archived has nobody
 * delivering it, so it rests the same way. An item reported from a live project, as old, still reads
 * stuck: the rule rests what is settled, not what is old.
 *
 * @direct-test-of packages/core/src/lib/standing-times.ts
 * @direct-test-of packages/core/src/feedback/standing.ts
 * @direct-test-of packages/core/src/feedback/forge-reads.ts
 * @direct-test-of packages/core/src/feedback/list-read.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

type Who = 'owner' | 'viewer';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let archivedId = '';
let liveId = '';
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const seq = (fb: string) => Number(fb.slice(3));

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'viewer'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.viewer, 'viewer');
  archivedId = (await createTestProject(people.owner)).id;
  liveId = (await createTestProject(people.owner)).id;
  await db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${archivedId}`);
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function filed(title: string): Promise<string> {
  return ok(
    await say('owner', 'POST', at('/feedback'), {
      kind: 'question',
      title,
      screen: '/projects/hop/board',
    }),
    201,
  ).feedback.key as string;
}

/**
 * Its filing and every decision on it moved `days` back, so each wait it holds is long overdue. A
 * decision is insert-only by its guard trigger, so the move runs with triggers off for this one
 * transaction: the test ages a record, it never edits what was decided.
 */
async function aged(fb: string, days: number) {
  await db.execute(sql`
    UPDATE feedback SET created_at = now() - make_interval(days => ${days})
     WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
  `);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE feedback_decisions SET decided_at = now() - make_interval(days => ${days})
       WHERE feedback_id = (SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)})
    `);
  });
}

/** A report of it through the Forge door, from `source`. */
async function reportedFrom(fb: string, source: string) {
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id)
    SELECT id, ${people.owner}, 'agent', ${source} FROM feedback
     WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
  `);
}

async function rowOf(fb: string): Promise<Doc> {
  const list = ok(await say('viewer', 'GET', at('/feedback')));
  const row = (list.feedback as Doc[]).find((f) => f.key === fb);
  expect(row, `${fb} is on the list`).toBeDefined();
  return row as Doc;
}

describe('Feedback reads stuck only what nobody moves (ISS-1072)', () => {
  it('an item reported from a live project and long untriaged reads stuck', async () => {
    const fb = await filed('Is the board meant to be read-only?');
    await reportedFrom(fb, liveId);
    await aged(fb, 30);
    const row = await rowOf(fb);
    expect(row.attentionGroup).toBe('stuck');
    expect(row.times.stuck).not.toBeNull();
  });

  it('an item reported only from an archived project, as old, rests: no due date, never stuck', async () => {
    const fb = await filed('Why does the HOP ward list lag?');
    await reportedFrom(fb, archivedId);
    await aged(fb, 30);
    const row = await rowOf(fb);
    expect(row.attentionGroup).not.toBe('stuck');
    expect(row.times).toMatchObject({ stuck: null, dueAt: null });
  });

  it('an item reported from an archived project and again from a live one is still live', async () => {
    const fb = await filed('Why does the export skip blanks?');
    await reportedFrom(fb, archivedId);
    await reportedFrom(fb, liveId);
    await aged(fb, 30);
    expect((await rowOf(fb)).attentionGroup).toBe('stuck');
  });

  it('a resolved item whose confirm is long owed keeps its wait and never reads stuck', async () => {
    const fb = await filed('Is the blank row a bug?');
    ok(
      await say('owner', 'POST', at(`/feedback/${fb}/triage`), {
        answers: TRIAGE_ANSWERS,
        route: 'answer',
        answer: 'It is by design.',
      }),
    );
    await aged(fb, 30);
    const row = await rowOf(fb);
    expect(row.phase).toBe('resolved');
    expect(row.attentionGroup).not.toBe('stuck');
    expect(row.waitingOn.kind).not.toBe('none');
    expect(row.times).toMatchObject({ stuck: null, dueAt: null });
  });
});
