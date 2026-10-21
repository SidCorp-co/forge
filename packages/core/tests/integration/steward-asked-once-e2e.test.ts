// REQ-48 BC-5, the judges' verdict on dev.270: the steward never asks again what a person already
// answered on the item, whichever question asked it (ISS-134 and ISS-284 were kept on 2026-10-14
// through the stale-draft question, and asked again), and it never asks beside a question still
// open there. One cause is diagnosed once: a requirement stuck through a carrier issue that is
// itself stuck is only noted, its note citing the carrier, and the carrier is diagnosed (REQ-45 and
// ISS-498). The standing read is a scripted one of its contract type, so each case states it.
//
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/sweep.ts

import type { Said } from '@forge/contracts/said';
import { STALE_DRAFT_OPTION_IDS } from '@forge/contracts/stale-drafts';
import type { ItemStanding } from '@forge/contracts/steward';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let standings: ItemStanding[] = [];
let diagnose: (issue: { id: string; key: string }, recommended: string) => Promise<string>;
let sweep: (now?: Date) => Promise<{ stuck: number; changed: number }>;

const said = (text: string) => ({ key: text }) as unknown as Said;

/** A stuck standing of `kind`, since `since`, carried by `carriedBy` where it was rolled up from one. */
function stuck(
  subject: { kind: 'issue' | 'requirement'; id: string; key: string },
  since: string,
  carriedBy: string | null = null,
): ItemStanding {
  const says = { who: said('Master'), act: said('take it'), rule: said('nobody serves') };
  return {
    subject,
    title: subject.key,
    group: 'stuck',
    waitingOn: {
      kind: carriedBy ? 'agent' : 'master',
      who: carriedBy ?? 'Master',
      act: 'take it',
      rule: 'nobody serves',
      ref: carriedBy,
      dueAt: null,
      says,
    },
    note: null,
    actClass: 'master_take',
    since,
    dueAt: null,
    stuck: {
      code: 'nobody_serves',
      since,
      reason: `${subject.key} waits and no master serves this project`,
      via: carriedBy,
      says: { reason: said('no master serves this project') },
    },
    carriedBy,
    basis: `basis-${subject.key}-${since}`,
  };
}

const draft = (seq: number) =>
  createTestIssue(projectId, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(Date.now() - 16 * 86_400_000),
  });

/** The stale-draft merge-or-drop question on `issueId`, answered keep by the owner now. */
async function keptThroughStaleDraft(issueId: string) {
  const made = ok(
    await say('owner', 'POST', '/api/questions', {
      issueId,
      prompt: 'A draft nobody has touched for 7 days. Drop it, or keep it?',
      options: [
        { id: STALE_DRAFT_OPTION_IDS.drop, label: 'Drop it' },
        { id: STALE_DRAFT_OPTION_IDS.keep, label: 'Keep it as a draft' },
      ].map((o) => ({
        ...o,
        authority: 'writer',
        bindsTo: 'this_call',
        executedBy: 'core',
        fingerprint: `stale-draft:${issueId}`,
      })),
      recommendedOptionId: STALE_DRAFT_OPTION_IDS.keep,
      blockerKind: 'human',
    }),
    201,
  );
  ok(
    await say('owner', 'POST', `/api/questions/${made.id as string}/answer`, {
      round: 1,
      optionId: STALE_DRAFT_OPTION_IDS.keep,
    }),
  );
  return made.id as string;
}

const questionsOn = (issueId: string) =>
  rows<{ id: string; status: string }>(sql`
    SELECT id, status FROM agent_questions WHERE issue_id = ${issueId} ORDER BY created_at`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { provideStewardStandings } = await import('../../src/steward/index.js');
  provideStewardStandings(async (pid) => (pid === projectId ? standings : []));
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  stewardId = await stewardAccountOf(projectId);
  say = requester(app, { owner: await signUserToken(ownerId) });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  sweep = (await import('../../src/steward/sweep.js')).sweepStandings;
  diagnose = async (issue, recommended) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
      RETURNING id`);
    const [run] = await db
      .select()
      .from(stewardRuns)
      .where(eq(stewardRuns.id, made?.id ?? ''));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [
      {
        tool: {
          name: 'steward_decide',
          args: { issue: issue.key, recommended, why: 'nothing has moved on it since' },
        },
      },
      { text: 'Done.' },
    ];
    await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId });
    return JSON.stringify(
      (script.sent.at(-1) ?? []).filter((m) => m.role === 'tool').map((m) => m.content),
    );
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("the steward reads a person's answers of every kind before it asks (REQ-48 BC-5)", () => {
  it('asks nothing on a draft a person kept through the stale-draft question since it read stuck', async () => {
    const issue = await draft(134);
    standings = [stuck({ kind: 'issue', ...issue }, '2026-10-05T00:00:00.000Z')];
    const kept = await keptThroughStaleDraft(issue.id);
    const said = await diagnose(issue, 'drop');
    expect(said).toContain(`was kept on the standing it reads now (question ${kept}`);
    expect(said).toContain('Keep it as a draft');
    expect(await questionsOn(issue.id)).toEqual([{ id: kept, status: 'answered' }]);
  });

  it('asks again where the keep was answered before the issue came to read as it does now', async () => {
    const issue = await draft(135);
    await keptThroughStaleDraft(issue.id);
    standings = [stuck({ kind: 'issue', ...issue }, new Date(Date.now() + 60_000).toISOString())];
    await diagnose(issue, 'drop');
    const open = (await questionsOn(issue.id)).filter((q) => q.status === 'open');
    expect(open).toHaveLength(1);
  });

  it('asks nothing beside a question of another kind still open on the issue', async () => {
    const issue = await draft(136);
    standings = [stuck({ kind: 'issue', ...issue }, '2026-10-05T00:00:00.000Z')];
    const made = ok(
      await say('owner', 'POST', '/api/questions', {
        issueId: issue.id,
        prompt: 'A draft nobody has touched for 7 days. Drop it, or keep it?',
        options: [
          { id: STALE_DRAFT_OPTION_IDS.drop, label: 'Drop it' },
          { id: STALE_DRAFT_OPTION_IDS.keep, label: 'Keep it as a draft' },
        ].map((o) => ({
          ...o,
          authority: 'writer',
          bindsTo: 'this_call',
          executedBy: 'core',
          fingerprint: `stale-draft:${issue.id}`,
        })),
        recommendedOptionId: STALE_DRAFT_OPTION_IDS.drop,
        blockerKind: 'human',
      }),
      201,
    );
    const said = await diagnose(issue, 'drop');
    expect(said).toContain(`question ${made.id as string} on ${issue.key} already asks it`);
    expect(await questionsOn(issue.id)).toHaveLength(1);
  });
});

describe('one cause is diagnosed once, at its carrier (REQ-48 BC-5)', () => {
  it('diagnoses the stuck carrier issue and only notes the requirement it carries', async () => {
    const carrier = await createTestIssue(projectId, ownerId, 498, {
      status: 'reopen',
      createdAt: new Date(),
    });
    const req = await createTestRequirement(projectId, 45, 'carried by a stuck issue');
    standings = [
      stuck(
        { kind: 'requirement', id: req.id, key: req.key },
        '2026-10-15T00:00:00.000Z',
        carrier.key,
      ),
      stuck({ kind: 'issue', ...carrier }, '2026-10-15T00:00:00.000Z'),
    ];
    const tally = await sweep(new Date());
    expect([tally.stuck, tally.changed]).toEqual([1, 1]);
    const emitted = await rows<{ type: string; subject: string }>(sql`
      SELECT type, payload -> 'subject' ->> 'key' AS subject FROM pipeline_outbox
       WHERE payload ->> 'projectId' = ${projectId} AND type IN ('standing.stuck', 'standing.changed')
       ORDER BY type`);
    expect(emitted).toEqual([
      { type: 'standing.changed', subject: req.key },
      { type: 'standing.stuck', subject: carrier.key },
    ]);
  });

  it('diagnoses the requirement itself where its carrier is not stuck', async () => {
    const carrier = await createTestIssue(projectId, ownerId, 499, {
      status: 'open',
      createdAt: new Date(),
    });
    const req = await createTestRequirement(projectId, 46, 'carried by a moving issue');
    standings = [
      stuck(
        { kind: 'requirement', id: req.id, key: req.key },
        '2026-10-16T00:00:00.000Z',
        carrier.key,
      ),
    ];
    const tally = await sweep(new Date());
    expect([tally.stuck, tally.changed]).toEqual([1, 0]);
  });
});
