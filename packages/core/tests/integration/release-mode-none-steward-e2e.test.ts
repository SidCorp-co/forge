/**
 * The steward's output check on a project of release mode `none` reads the build it weighs from the
 * one definition the record and coverage read (`release-batch/landed-build.ts`): both of its reasons,
 * a verdict counting on the running build and the design's proof plan, are met by passes at the
 * landed commit, and its reopen over them is refused `STEWARD_REOPEN_COUNTED`. Planted from
 * adminhub-api ISS-5 (reopened at 10:46:37 on 2026-10-22 with passes at its landed head f4e5fb6) and
 * ISS-1 (reopened at 11:30 with 17 passes at its landed head), through the steward's own door.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  D9,
  F4,
  judgedAll,
  LATER,
  landedIssue,
  seedLandedWorld,
  statusOf,
  verdict,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/shipped-earlier.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/shipped-earlier.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

let projectId: string;
let ownerId: string;
let token: string;

beforeEach(async () => {
  await seedLandedWorld();
  ({ projectId, ownerId, token } = world);
});

describe("the steward's output check reads the same landed build", () => {
  async function stewardReopens(
    issueId: string,
    issueKey: string,
    reason = 'Criterion 1 has no counting verdict on a running build and no release proof.',
  ) {
    const { callStewardDoor } = await import('../../src/steward/doors.js');
    const [run] = (await db.execute(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before, started_at)
      VALUES (${projectId}, 'issue', ${issueId}, ${issueKey}, 'release.asked', '[]'::jsonb,
              ARRAY['output_check']::text[], 'running', now(), now())
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const ctx = {
      projectId,
      runId: run?.id ?? '',
      act: 'output_check' as const,
      subject: { kind: 'issue', id: issueId, key: issueKey },
      standing: null,
      token,
      refused: [] as string[],
      broken: [] as string[],
      acts: [] as string[],
    };
    const answer = await callStewardDoor(
      'steward_move_issue',
      JSON.stringify({
        issue: issueKey,
        to: 'reopen',
        reason,
      }),
      ctx,
    );
    return { answer, refused: ctx.refused };
  }

  it('refuses to send back ISS-5 when every criterion passes at the landed head', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    const { answer, refused } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_COUNTED');
    expect(refused[0]).toContain('STEWARD_REOPEN_COUNTED');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('still sends it back when its passes stand only at the pre-merge head d9fd508', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, D9);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('still sends it back when its passes stand at a later head nothing has recorded', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, LATER);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('still sends it back when a verdict at the landed head fails', async () => {
    const issue = await landedIssue(5, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'fail', F4);
    await verdict(issue, 3, 'pass', F4);

    const { answer } = await stewardReopens(issue, 'ISS-5');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });
});

describe("the steward's second reason, the design's proof plan, reads the landed build too", () => {
  // adminhub-api ISS-1, reopened at 11:30 on 2026-10-22 with all 17 criteria passing at the
  // release/stg head it landed on: "every criterion has a verdict only at 5da145a1a260, none counting
  // on the running build, whose source cannot be read; and no evidence the release will run the
  // design's proof plan".
  const HEAD = '5da145a1a2600000000000000000000000000000';
  const BEFORE = '5da145a1a2610000000000000000000000000000';
  const REASON =
    "Criteria 1-17 have verdicts only at commit 5da145a1a260 and none counting on the running build, whose source cannot be read; nothing shows the release will run the design's proof plan.";
  const STATEMENTS = Array.from({ length: 17 }, (_, i) => `Criterion ${i + 1} holds on the box`);

  /** The design's line for every live criterion, each naming its proof. */
  async function proofPlan(issueId: string) {
    await db.execute(sql`
      INSERT INTO issue_designs (issue_id, project_id, revision, modules, contracts, recorded_by, recorded_agency)
      VALUES (${issueId}, ${projectId}, 1, ARRAY[${randomUUID()}]::uuid[], '{}'::text[], ${ownerId}, 'agent')
    `);
    await db.execute(sql`
      INSERT INTO issue_design_criteria (criterion_id, issue_id, criterion_class, pattern, proof)
      SELECT id, issue_id, 'observable', NULL, 'the probe replays it on the box'
        FROM issue_criteria WHERE issue_id = ${issueId} AND retired_at IS NULL
    `);
  }

  async function stewardOn(issueId: string) {
    const { callStewardDoor } = await import('../../src/steward/doors.js');
    const [run] = (await db.execute(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before, started_at)
      VALUES (${projectId}, 'issue', ${issueId}, 'ISS-1', 'release.asked', '[]'::jsonb,
              ARRAY['output_check']::text[], 'running', now(), now())
      RETURNING id`)) as unknown as Array<{ id: string }>;
    return callStewardDoor(
      'steward_move_issue',
      JSON.stringify({ issue: 'ISS-1', to: 'reopen', reason: REASON }),
      {
        projectId,
        runId: run?.id ?? '',
        act: 'output_check',
        subject: { kind: 'issue', id: issueId, key: 'ISS-1' },
        standing: null,
        token,
        refused: [],
        broken: [],
        acts: [],
      },
    );
  }

  it('does not reopen ISS-1 with 17 passes at its landed head, by either reason', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 17; n += 1) await verdict(issue, n, 'pass', HEAD);

    const answer = await stewardOn(issue);

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_COUNTED');
    expect(answer.text).toContain(
      "The design's proof plan is met the same way: each of the 17 criteria",
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('still reopens it where one planned criterion passes only before the landed head', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 16; n += 1) await verdict(issue, n, 'pass', HEAD);
    await verdict(issue, 17, 'pass', BEFORE);

    const answer = await stewardOn(issue);

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });
});
