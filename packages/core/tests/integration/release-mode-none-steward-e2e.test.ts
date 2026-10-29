/**
 * The steward's output check on a project of release mode `none` reads the build it weighs from the
 * one definition the record and coverage read (`release-batch/landed-build.ts`): both of its reasons,
 * a verdict counting on the running build and the design's proof plan, are met by passes at the
 * landed commit, and its facts say so (`stewardReleaseFacts`). It sends no issue back
 * (`steward/door-writes.ts:MOVE`): landed work that only owes verdicts at its landing stays at the
 * gate, its facts naming what is owed. Planted from adminhub-api ISS-5 and ISS-1 (reopened on
 * 2026-10-22 with passes at their landed heads) and catalog-fe ISS-11 and ISS-14..19 (reopened on
 * 2026-10-26 over verdicts owed at the landing, and bounced back to `reopen` when moved to the gate).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { stewardReleaseFacts } from '../../src/release-batch/index.js';
import {
  ASIDE,
  D9,
  F4,
  judgedAll,
  LATER,
  landedIssue,
  record,
  seedLandedWorld,
  statusOf,
  verdict,
  world,
} from '../helpers/landed-world.js';

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
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

/** The steward's own door, asked to send `issueKey` back as its output check would. */
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
    JSON.stringify({ issue: issueKey, to: 'reopen', reason }),
    ctx,
  );
  return { answer, refused: ctx.refused };
}

/** The door refuses the move by its field, and the issue stays at the gate. */
async function sendsNothingBack(issueId: string, issueKey: string) {
  const { answer } = await stewardReopens(issueId, issueKey);
  expect(answer.ok).toBe(false);
  expect(answer.text).toContain('to');
  expect(await statusOf(issueId)).toBe('awaiting_release');
}

const facts = (issueId: string) => stewardReleaseFacts(projectId, issueId);

describe("the steward's output check reads the same landed build", () => {
  it('says ISS-5 misses nothing when every criterion passes at the landed head', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, F4);

    expect(await facts(issue)).toContain(
      'No evidence is missing: wake the master to record the landing',
    );
    await sendsNothingBack(issue, 'ISS-5');
  });

  // catalog-fe ISS-11, 2026-10-26 03:53Z: landed, its passes at an earlier commit, and reopened as if
  // its code were wrong; a judge declared over the reopen then read as its builder
  it('keeps ISS-5 at the gate when its passes stand only at the pre-merge head, naming the verdicts owed at the landing', async () => {
    const issue = await landedIssue(5, F4);
    await judgedAll(issue, D9);

    const said = await facts(issue);
    expect(said).toContain(
      'its work has landed, and what it lacks is a counting verdict at that landing',
    );
    expect(said).toContain('criterion 1:');
    expect(said).toContain(`dispatch a judge at \`${F4.slice(0, 12)}\``);
    await sendsNothingBack(issue, 'ISS-5');
  });

  // catalog-fe ISS-1, 2026-10-22: marked at its landing, every criterion re-judged at a later head
  // holding it, reopened before the record at that head that then went through
  it('names the record a pass at a later head needs, and the record at that head then closes it', async () => {
    const issue = await landedIssue(1, F4);
    await judgedAll(issue, LATER);

    // no landing Forge recorded is at LATER, so the steward reads no host to place it after F4: it
    // says the record at that head is what counts the pass, and that record's own door reads it
    expect(await facts(issue)).toContain(
      `it was judged at \`${LATER.slice(0, 12)}\`, not at \`${F4.slice(0, 12)}\`: a verdict at an earlier commit judged another build, and one at a later head counts only on a record made at that head`,
    );
    await sendsNothingBack(issue, 'ISS-1');
    const recorded = await record([issue], LATER);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(await statusOf(issue)).toBe('closed');
  });

  it('names the verdicts owed when its passes split between the landing and a later head', async () => {
    const issue = await landedIssue(1, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'pass', LATER);
    await verdict(issue, 3, 'pass', LATER);

    const said = await facts(issue);
    expect(said).toContain('criterion 2:');
    expect(said).not.toContain('criterion 1:');
    await sendsNothingBack(issue, 'ISS-1');
  });

  it('names the verdicts owed when every pass sits at a commit not holding the landing', async () => {
    const issue = await landedIssue(1, F4);
    await judgedAll(issue, ASIDE);

    expect(await facts(issue)).toContain('owing: criterion 1:');
    await sendsNothingBack(issue, 'ISS-1');
  });

  it('names no verdict owed where a verdict at the landed head fails: the fail reopens it, not the steward', async () => {
    const issue = await landedIssue(5, F4);
    await verdict(issue, 1, 'pass', F4);
    await verdict(issue, 2, 'fail', F4);
    await verdict(issue, 3, 'pass', F4);

    const said = await facts(issue);
    expect(said).not.toContain('owing:');
    expect(said).not.toContain('No evidence is missing');
    await sendsNothingBack(issue, 'ISS-5');
  });
});

describe("the steward's second reason, the design's proof plan, reads the landed build too", () => {
  // adminhub-api ISS-1, reopened at 11:30 on 2026-10-22 with all 17 criteria passing at the
  // release/stg head it landed on
  const HEAD = '5da145a1a2600000000000000000000000000000';
  const BEFORE = '5da145a1a2610000000000000000000000000000';
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

  it('says ISS-1 with 17 passes at its landed head misses nothing, by either reason', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 17; n += 1) await verdict(issue, n, 'pass', HEAD);

    expect(await facts(issue)).toContain(
      "The design's proof plan is met the same way: each of the 17 criteria",
    );
    await sendsNothingBack(issue, 'ISS-1');
  });

  it('names criterion 17 owed where it passes only before the landed head', async () => {
    const issue = await landedIssue(1, HEAD, STATEMENTS);
    await proofPlan(issue);
    for (let n = 1; n <= 16; n += 1) await verdict(issue, n, 'pass', HEAD);
    await verdict(issue, 17, 'pass', BEFORE);

    const said = await facts(issue);
    expect(said).toContain('criterion 17:');
    expect(said).not.toContain('criterion 16:');
    await sendsNothingBack(issue, 'ISS-1');
  });
});
