// ISS-1006, owner 2026-11-05: a person decides from three plain lines the agent that asks writes.
// A run's question and the steward's decision carry `plain`, stored on the round beside the prompt,
// and the Needs you decision a screen draws reads it. A question sent without it, or with an issue
// key in it, is asked all the same (owner ruling: teach, never block); the decision then reads
// `plain: null`, which the screens show as "the agent wrote no summary".
//
// @direct-test-of packages/core/src/questions/write.ts
// @direct-test-of packages/core/src/questions/routes.ts
// @direct-test-of packages/core/src/steward/door-decide.ts
// @direct-test-of packages/core/src/steward/decision-ask.ts
// @direct-test-of packages/core/src/development/needs-you-decision-builders.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import {
  completeIssueReadyRecord,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { underStrict } from '../helpers/project-controls.js';
import { resetScript, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

const PLAIN =
  'Customers get an Export CSV button on the orders page.\nSales waits on it for the weekly report.\nI recommend turning it on now.';

let say: (who: 'owner' | 'steward', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let stewardId = '';
let seq = 300;
let diagnose: (issue: { id: string; key: string }, args: Record<string, unknown>) => Promise<void>;

const stepsOf = async (questionId: string) =>
  (await rows<{ steps: Doc[] }>(sql`SELECT steps FROM agent_questions WHERE id = ${questionId}`))[0]
    ?.steps ?? [];

const decisionOf = async (questionId: string) => {
  await settleOutbox();
  const read = ok(await say('owner', 'GET', `/api/projects/${projectId}/needs-you/decisions`));
  return (read.decisions as Doc[]).find((d) => d.id === `question:${questionId}`);
};

/** A run's question on an issue that serves no requirement or feedback, as POST /api/questions takes it. */
async function askOnIssue(extra: Record<string, unknown>): Promise<Reply> {
  seq += 1;
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  return say('owner', 'POST', '/api/questions', {
    issueId: issue.id,
    prompt: 'Turn the CSV export on now, or after the release?',
    options: [
      { id: 'now', label: 'Turn it on now', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
      { id: 'later', label: 'Wait for the release', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
    ],
    recommendedOptionId: 'now',
    ...extra,
  });
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  stewardId = await stewardAccountOf(projectId);
  const stewardToken = (
    await mintStewardCredential({ projectId, stewardId, acts: ['stuck_diagnosis'], ttlMs: 30 * 60_000 })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId), steward: stewardToken });
  const { db } = await import('../../src/db/client.js');
  const { stewardRuns } = await import('../../src/db/schema-steward-runs.js');
  const { runGatewayAct } = await import('../../src/steward/turn.js');
  const { eq } = await import('drizzle-orm');
  diagnose = async (issue, args) => {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                                state, not_before, started_at, ended_at)
      VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
              ARRAY['stuck_diagnosis']::text[], 'done', now(), now(), now())
      RETURNING id`);
    const [run] = await db.select().from(stewardRuns).where(eq(stewardRuns.id, made?.id ?? ''));
    if (!run) throw new Error('the run row was not written');
    resetScript();
    script.steps = [{ tool: { name: 'steward_decide', args } }, { text: 'Asked.' }];
    await runGatewayAct({ run, act: 'stuck_diagnosis', standing: null, stewardId });
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a run's question carries the plain text a person decides from", () => {
  it('stores `plain` on the round, and the Needs you decision reads it', async () => {
    const r = await askOnIssue({ plain: PLAIN });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const [step] = await stepsOf(String(r.json.id));
    expect(step?.plain).toBe(PLAIN);
    expect((await decisionOf(String(r.json.id)))?.plain).toBe(PLAIN);
  });

  it('asks a question sent without `plain` all the same, and its decision says the asker wrote none', async () => {
    const r = await askOnIssue({});
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const [step] = await stepsOf(String(r.json.id));
    expect(step).not.toHaveProperty('plain');
    const decision = await decisionOf(String(r.json.id));
    expect(decision).toBeDefined();
    expect(decision?.plain).toBeNull();
  });

  it('asks one whose `plain` leans on an issue key, and stores it as written: nothing is refused', async () => {
    const keyed = 'Merge ISS-89 into ISS-98 under REQ-9 BC-2.';
    const r = await askOnIssue({ plain: keyed });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await stepsOf(String(r.json.id)))[0]?.plain).toBe(keyed);
  });

  it('stores an empty `plain` as none', async () => {
    const r = await askOnIssue({ plain: '   ' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await stepsOf(String(r.json.id)))[0]).not.toHaveProperty('plain');
  });
});

describe("the steward's decision carries the plain text too", () => {
  async function readyDraft() {
    seq += 1;
    const issue = await createTestIssue(projectId, ownerId, seq, {
      status: 'draft',
      createdAt: new Date(Date.now() - 16 * 86_400_000),
    });
    await completeIssueReadyRecord(projectId, ownerId, issue.id, 700 + seq);
    return issue;
  }
  const openQuestion = async (issueId: string) =>
    (
      await rows<{ id: string; steps: Doc[] }>(sql`
        SELECT id, steps FROM agent_questions WHERE issue_id = ${issueId} AND status = 'open'`)
    )[0];

  it('stores the steward_decide `plain` on the round it asks', async () => {
    const issue = await readyDraft();
    // a serious decision on a strict project is a person's, so Needs you lists it (REQ-79 BC-13)
    await underStrict(projectId, ownerId, () =>
      diagnose(issue, {
        about: issue.key,
        recommended: 'open',
        why: 'it carries open feedback and nothing else covers it',
        serious: true,
        plain: PLAIN,
      }),
    );
    const q = await openQuestion(issue.id);
    expect(q, 'the steward asked its decision').toBeDefined();
    expect(q?.steps[0]?.plain, JSON.stringify(q?.steps)).toBe(PLAIN);
    expect((await decisionOf(String(q?.id)))?.plain).toBe(PLAIN);
  });

  it('asks a steward decision without `plain` all the same', async () => {
    const issue = await readyDraft();
    await underStrict(projectId, ownerId, () =>
      diagnose(issue, {
        about: issue.key,
        recommended: 'open',
        why: 'it carries open feedback and nothing else covers it',
        serious: true,
      }),
    );
    const q = await openQuestion(issue.id);
    expect(q, 'the steward asked its decision').toBeDefined();
    expect(q?.steps[0]).not.toHaveProperty('plain');
    expect((await decisionOf(String(q?.id)))?.plain).toBeNull();
  });
});
