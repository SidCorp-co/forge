// REQ-68 BC-4 (ISS-687 round 4): a stuck issue reaches a person only as a decision on its item. Judge
// run d47d6de0 at dev.489 found no Needs you entry asking about ISS-643 (serving no requirement or
// feedback item) and read ISS-643's Activity: "Asked nobody about ISS-643: … waits on orchestrator,
// qa to answer a question … nobody could be asked. Act on the item yourself". The path that wrote it:
// a stuck diagnosis ending unmoved asked through the wake door, which read a person's answer as
// nobody's to ask (`door-wake.ts`, `to: 'person'`), and `diagnosis-end.ts` logged "Asked nobody".
// Round 2 then turned that wait into kind `answer`, and the door woke the master about a question
// only a person answers.
//
// Now an issue waiting on a person's answer has its open question placed on the item it serves
// (`questions/on-item.ts`), by one rule: the requirement it delivers, else the feedback item it
// carries, else the requirement the steward names in `item`, else it stays the project's question.
// Needs you lists each, opening that item, and the act names no person. The issue's Activity draws
// no act that only said something (why nobody was asked, a note's words) and no override line.
//
// Planted red: `askAddresseeOf` without its `answer` branch (the master is woken and the question
// stays on the issue), and `actsOfSubject` without `asIssueActivity` (the planted SAY act is drawn).
//
// @direct-test-of packages/core/src/steward/door-wake.ts
// @direct-test-of packages/core/src/steward/ask-addressee.ts
// @direct-test-of packages/core/src/steward/diagnosis-end.ts
// @direct-test-of packages/core/src/steward/acts-store.ts
// @direct-test-of packages/core/src/questions/on-item.ts

import type { ItemStanding } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
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

type Doors = typeof import('../../src/steward/doors.js');
type End = typeof import('../../src/steward/diagnosis-end.js');
type DoorContext = import('../../src/steward/door-kit.js').DoorContext;

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let doors: Doors;
let end: End;
let projectId = '';
let ownerId = '';
let stewardToken = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

/** A parked issue at needs_info whose open question a person owes, asked before `about` existed. */
async function parked(seq: number, prompt: string) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'needs_info',
    waitingKind: 'needs_answer',
    createdAt: new Date(Date.now() - 9 * 86_400_000),
  });
  // the shape ISS-643's question has on dev: a run's choice, recommended, owed by a person
  const step = {
    round: 1,
    prompt,
    askedAt: new Date().toISOString(),
    answerShape: 'choice',
    options: ['ci-token', 'by-hand'].map((id) => ({
      id,
      label: `Carry it by ${id}`,
      bindsTo: 'project',
      authority: 'admin',
      executedBy: 'agent',
    })),
    recommendedOptionId: 'ci-token',
  };
  const [q] = await rows<{ id: string }>(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (gen_random_uuid(), ${projectId}, ${issue.id}, 'open', 'human', ${JSON.stringify([step])}::jsonb)
    RETURNING id`);
  return { ...issue, questionId: q?.id ?? '' };
}

/** The issue's standing as the steward reads it, read stuck. */
async function stuckStanding(key: string): Promise<ItemStanding> {
  const { openStandings } = await import('../../src/standing/index.js');
  const row = (await openStandings(projectId)).find((r) => r.subject.key === key);
  if (!row) throw new Error(`no standing for ${key}`);
  return {
    ...row,
    group: 'stuck',
    stuck: {
      code: 'overdue',
      since: '2026-10-30T00:00:00.000Z',
      reason: `${key} is overdue`,
      via: null,
      says: { reason: { key: 'standing.stuck.overdue' } as never },
    },
  };
}

/** A stuck diagnosis run on the issue, and the context its turn calls doors in. */
async function runOn(issue: { id: string; key: string }): Promise<DoorContext> {
  const standing = await stuckStanding(issue.key);
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events, acts_to_run,
                              basis, state, not_before, started_at)
    VALUES (${projectId}, 'issue', ${issue.id}, ${issue.key}, 'standing.stuck', '[]'::jsonb,
            ARRAY['stuck_diagnosis']::text[], ${standing.basis}, 'running', now(), now())
    RETURNING id`);
  return {
    projectId,
    runId: run?.id ?? '',
    act: 'stuck_diagnosis',
    subject: { kind: 'issue', id: issue.id, key: issue.key },
    standing,
    token: stewardToken,
    refused: [],
    broken: [],
    acts: [],
  };
}

const wake = (ctx: DoorContext, args: Record<string, unknown>) =>
  doors.callStewardDoor('steward_wake_master', JSON.stringify(args), ctx);

const aboutOf = async (questionId: string) =>
  (
    await rows<{ about: Doc | null }>(
      sql`SELECT about FROM agent_questions WHERE id = ${questionId}`,
    )
  )[0]?.about ?? null;

const actsOfRun = (runId: string) =>
  rows<{ door: string; did: string; master_ask: string | null }>(sql`
    SELECT door, did, master_ask FROM steward_acts WHERE run_id = ${runId} ORDER BY at`);

/** The owner's Needs you decision asking this question, and the item it opens. */
async function needsYouOf(questionId: string): Promise<Doc | undefined> {
  const read = ok(await as('GET', '/needs-you/decisions'));
  return (read.decisions as Doc[]).find((d) => d.id === `question:${questionId}`);
}

/** No person or role is named as owing an act: the words the judge read on dev.489. */
const NAMES_A_PERSON =
  /nobody could be asked|act on the item yourself|a person's act|waits on [a-z]+, [a-z]+/i;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const { stewardAccountOf } = await import('../../src/steward/account.js');
  const { mintStewardCredential } = await import('../../src/steward/credential.js');
  stewardToken = (
    await mintStewardCredential({
      projectId,
      stewardId: await stewardAccountOf(projectId),
      acts: ['stuck_diagnosis'],
      ttlMs: 30 * 60_000,
    })
  ).token;
  say = requester(app, { owner: await signUserToken(ownerId) });
  doors = await import('../../src/steward/doors.js');
  end = await import('../../src/steward/diagnosis-end.js');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a stuck issue's question is asked on the requirement it delivers", () => {
  it('places it there, lists it in Needs you opening that requirement, and wakes no master', async () => {
    const issue = await parked(639, 'ISS-639: should feedback triage get an approvals switch?');
    const { requirementId } = await completeIssueReadyRecord(projectId, ownerId, issue.id, 66);
    const ctx = await runOn(issue);

    const out = await wake(ctx, {
      about: issue.key,
      ask: `Answer the question ${issue.key} waits on.`,
    });

    expect(out.ok, out.text).toBe(true);
    expect(await aboutOf(issue.questionId)).toEqual({ kind: 'requirement', requirementId });
    expect((await needsYouOf(issue.questionId))?.opens).toEqual({
      kind: 'requirement',
      key: 'REQ-66',
    });
    const acts = await actsOfRun(ctx.runId);
    expect(acts.map((a) => a.door)).toEqual(['ASK question on its item']);
    expect(acts[0]?.master_ask).toBeNull();
    expect(acts[0]?.did).toMatch(/^Asked on REQ-66 about ISS-639: ISS-639: should feedback triage/);
    expect(acts[0]?.did).not.toMatch(NAMES_A_PERSON);
  });

  it('asks it once on that standing: a second ask is told it stands, and writes nothing', async () => {
    const issue = await parked(640, 'ISS-640: which export format?');
    await completeIssueReadyRecord(projectId, ownerId, issue.id, 67);
    const ctx = await runOn(issue);
    expect(
      (await wake(ctx, { about: issue.key, ask: 'Answer the question it waits on.' })).ok,
    ).toBe(true);
    const again = await wake(ctx, { about: issue.key, ask: 'Answer the question it waits on.' });
    expect(again.ok).toBe(false);
    expect(again.text).toContain('was asked on the item it serves on this standing');
    expect(await actsOfRun(ctx.runId)).toHaveLength(1);
  });
});

describe('an issue serving no requirement or feedback item (ISS-643 on dev.489)', () => {
  it('is asked about the requirement the steward names as the one it serves', async () => {
    const named = ok(
      await as('POST', '/requirements', {
        title: 'The whole suite reopens the merge it names',
        reason: 'a red nightly names its breaking merge',
        criteria: [{ body: 'A red whole-suite run reopens the issue of the merge it names.' }],
      }),
      201,
    ).key as string;
    const issue = await parked(643, 'ISS-643: what carries a red whole-suite verdict into core?');
    const ctx = await runOn(issue);

    const out = await wake(ctx, {
      about: issue.key,
      ask: 'Answer the question it waits on.',
      item: named,
    });

    expect(out.ok, out.text).toBe(true);
    const [req] = await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND 'REQ-' || req_seq = ${named}`,
    );
    expect(await aboutOf(issue.questionId)).toEqual({
      kind: 'requirement',
      requirementId: req?.id,
    });
    expect((await needsYouOf(issue.questionId))?.opens).toEqual({
      kind: 'requirement',
      key: named,
    });
    expect((await actsOfRun(ctx.runId))[0]?.did).toMatch(
      new RegExp(`^Asked on ${named} about ISS-643`),
    );
  });

  it('refuses a named requirement the project does not hold, by name, placing nothing', async () => {
    const issue = await parked(644, 'ISS-644: which runner image?');
    const ctx = await runOn(issue);
    const out = await wake(ctx, {
      about: issue.key,
      ask: 'Answer the question it waits on.',
      item: 'REQ-999',
    });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('`REQ-999`, which names no requirement of this project');
    expect(await aboutOf(issue.questionId)).toBeNull();
  });

  it("where the steward names none and asks nothing, stays the project's question in Needs you, and the act names nobody", async () => {
    const issue = await parked(645, 'ISS-645: what carries the verdict into core?');
    const ctx = await runOn(issue);

    // the turn ended on its note alone: Forge asks for it (`diagnosis-end.ts`)
    await end.endUnmovedDiagnosis(ctx);

    expect(await aboutOf(issue.questionId)).toBeNull();
    const listed = await needsYouOf(issue.questionId);
    expect(listed, 'Needs you lists the question').toBeDefined();
    expect(listed?.opens ?? null).toBeNull();
    const acts = await actsOfRun(ctx.runId);
    expect(acts.map((a) => a.door)).toEqual(['ASK question on its item']);
    expect(acts[0]?.did).toMatch(/^Asked in Needs you about ISS-645, as the project's question: /);
    expect(acts.some((a) => a.door.startsWith('SAY '))).toBe(false);
    expect(acts.some((a) => a.master_ask !== null)).toBe(false);
  });
});

describe("an issue's Activity draws no act telling a person to act", () => {
  it('leaves out an old "asked nobody" act and a note write, and draws no override line', async () => {
    const issue = await parked(646, 'ISS-646: which queue?');
    const ctx = await runOn(issue);
    // the two acts ISS-643 drew on dev.489, written as the old path wrote them
    await rows(sql`
      INSERT INTO steward_acts (run_id, project_id, act, door, did)
      VALUES (${ctx.runId}, ${projectId}, 'stuck_diagnosis', 'SAY nobody asked',
              ${`Asked nobody about ${issue.key}: ${issue.key} waits on orchestrator, qa to answer a question: a person's act, on their Needs you, which the master's account holds no permission for`}),
             (${ctx.runId}, ${projectId}, 'stuck_diagnosis',
              ${`PUT /api/projects/${projectId}/steward-notes/issue/${issue.key}`},
              ${`Wrote the note on ${issue.key}: ${issue.key} remains blocked because orchestrator and QA owe an overdue answer to its question.`})
      RETURNING id`);
    await end.endUnmovedDiagnosis(ctx);

    const read = ok(await as('GET', `/steward-acts?subject=${issue.key}`));
    const acts = read.acts as Doc[];
    expect(acts.map((a) => a.door)).toEqual(['ASK question on its item']);
    expect(acts.every((a) => a.override === null)).toBe(true);
    expect(JSON.stringify(acts)).not.toMatch(NAMES_A_PERSON);
  });
});
