/**
 * Migration 0623, run by drizzle's own migrator over the rows a deploy can find (ISS-1084): each
 * question comment a steward check posted before ISS-688 that is still open becomes a question row
 * under the comment's own id, about its requirement and owed by the project's master, free text with
 * its prompt, its options as written and the option it recommended. A comment answered by a reply, an
 * undone act, a note, an ended requirement and a question row already there are left as they are.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0623_a_check_question_is_a_question';

const BODY =
  'Which environments count as production-tier?\n\nOptions: marked-production: Use an environment marked Production; only there.; name-based: Treat production or prod as production-tier.. Recommended: marked-production.';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let stewardId: string;
let personId: string;
let seq = 0;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

async function user(kind: 'human' | 'agent'): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${id}, ${`${id}@forge.test`}, '!x', ${kind})`;
  return id;
}

async function requirement(status: string): Promise<{ id: string; key: string }> {
  seq += 1;
  const id = randomUUID();
  await m.sql`INSERT INTO requirements (id, project_id, req_seq, title) VALUES (${id}, ${projectId}, ${seq}, ${`req ${seq}`})`;
  await m.sql`
    INSERT INTO requirement_revisions (requirement_id, revision, spec, reason, author_id, author_agency)
    VALUES (${id}, 1, '{}'::jsonb, 'first cut', ${personId}, 'human')`;
  // a planted status, as the kernel's transition would have left it
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`UPDATE requirements SET status = ${status}, current_revision = 1 WHERE id = ${id}`;
  });
  return { id, key: `REQ-${seq}` };
}

/** A comment on `req` and, where `act` says, the steward act of a check citing it. */
async function asked(
  req: { id: string; key: string },
  opts: {
    body?: string;
    intent?: string;
    act?: 'intake_check' | 'breakdown_check' | 'note' | null;
    undone?: boolean;
  } = {},
): Promise<string> {
  const commentId = randomUUID();
  await m.sql`
    INSERT INTO comments (id, requirement_id, author_id, body, intent, created_at, updated_at)
    VALUES (${commentId}, ${req.id}, ${stewardId}, ${opts.body ?? BODY}, ${opts.intent ?? 'question'},
            '2026-10-28T03:00:30.123Z', '2026-10-28T03:00:30.123Z')`;
  const act = opts.act === undefined ? 'intake_check' : opts.act;
  if (act === null) return commentId;
  const runId = randomUUID();
  await m.sql`
    INSERT INTO steward_runs (id, project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, ended_at)
    VALUES (${runId}, ${projectId}, 'requirement', ${req.id}, ${req.key}, 'requirement.agreed',
            '[]'::jsonb, ARRAY[${act}]::text[], 'done', now(), now())`;
  await m.sql`
    INSERT INTO steward_acts (run_id, project_id, act, door, did, wrote, undo, undone_at)
    VALUES (${runId}, ${projectId}, ${act}, 'POST /api/projects/p/requirements/REQ-1/comments',
            'Asked', ${m.sql.json({ kind: 'comment', ref: commentId })},
            ${m.sql.json({ door: 'DELETE /api/x', body: null })},
            ${opts.undone ? new Date() : null})`;
  return commentId;
}

const questionOf = async (id: string) =>
  (
    await m.sql<
      {
        project_id: string;
        status: string;
        blocker_kind: string;
        asked_by: string;
        about: unknown;
        steps: Record<string, unknown>[];
        created_at: Date;
        requirement_id: string | null;
      }[]
    >`SELECT project_id, status, blocker_kind, asked_by, about, steps, created_at, requirement_id
        FROM agent_questions WHERE id = ${id}`
  )[0];

beforeEach(async () => {
  m = await ground.fresh();
  personId = await user('human');
  stewardId = await user('agent');
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${personId})`;
  projectId = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${personId})`;
});

afterEach(async () => {
  await m.drop();
});

describe('0623: a check question comment still open', () => {
  it('becomes a question under its own id, about its requirement and owed by the master', async () => {
    const req = await requirement('agreed');
    const id = await asked(req);
    await m.migrate();
    const q = await questionOf(id);
    expect(q).toMatchObject({
      project_id: projectId,
      status: 'open',
      blocker_kind: 'master_or_peer',
      asked_by: stewardId,
      about: { kind: 'requirement', requirementId: req.id },
      requirement_id: null,
    });
    expect(q?.created_at.toISOString()).toBe('2026-10-28T03:00:30.123Z');
    expect(q?.steps).toEqual([
      {
        round: 1,
        answerShape: 'free_text',
        prompt: 'Which environments count as production-tier?',
        needed:
          'Options: marked-production: Use an environment marked Production; only there.; name-based: Treat production or prod as production-tier.. Recommended: marked-production.',
        recommended: 'marked-production',
        askedAt: '2026-10-28T03:00:30.123Z',
      },
    ]);
  });

  it('is lifted from a breakdown check and on an in-delivery, delivered or deferred requirement, a body with no options asked whole', async () => {
    const lifted = [
      await asked(await requirement('in_delivery'), { act: 'breakdown_check' }),
      await asked(await requirement('delivered')),
      await asked(await requirement('deferred')),
    ];
    const bare = await asked(await requirement('agreed'), { body: 'Is BC-2 judged on staging?' });
    await m.migrate();
    for (const id of lifted) expect((await questionOf(id))?.status).toBe('open');
    expect((await questionOf(bare))?.steps[0]).toEqual({
      round: 1,
      answerShape: 'free_text',
      prompt: 'Is BC-2 judged on staging?',
      needed: 'The answer, in your own words.',
      askedAt: '2026-10-28T03:00:30.123Z',
    });
  });

  it('leaves alone what holds nothing: a replied question, an undone act, a note, an ended requirement, an act of no check', async () => {
    const req = await requirement('agreed');
    const replied = await asked(req);
    await m.sql`
      INSERT INTO comments (requirement_id, author_id, body, intent, parent_id)
      VALUES (${req.id}, ${personId}, 'marked-production', 'note', ${replied})`;
    const selfReplied = await asked(req);
    await m.sql`
      INSERT INTO comments (requirement_id, author_id, body, intent, parent_id)
      VALUES (${req.id}, ${stewardId}, 'still waiting', 'note', ${selfReplied})`;
    const undone = await asked(req, { undone: true });
    const note = await asked(req, { intent: 'note' });
    const ended = await asked(await requirement('accepted'));
    const dropped = await asked(await requirement('dropped'));
    const noCheck = await asked(req, { act: 'note' });
    const noAct = await asked(req, { act: null });
    await m.migrate();
    for (const id of [replied, undone, note, ended, dropped, noCheck, noAct]) {
      expect(await questionOf(id), id).toBeUndefined();
    }
    // a reply by the steward itself answers nothing: that one is still a question
    expect((await questionOf(selfReplied))?.status).toBe('open');
  });

  it('keeps a question row already standing under that id', async () => {
    const req = await requirement('agreed');
    const id = await asked(req);
    await m.sql`
      INSERT INTO agent_questions (id, project_id, status, blocker_kind, steps)
      VALUES (${id}, ${projectId}, 'answered', 'human',
              ${m.sql.json([{ round: 1, answerShape: 'free_text', prompt: 'kept', needed: 'x', askedAt: '2026-10-28T00:00:00.000Z' }])})`;
    await m.migrate();
    expect(await questionOf(id)).toMatchObject({ status: 'answered', blocker_kind: 'human' });
  });
});
