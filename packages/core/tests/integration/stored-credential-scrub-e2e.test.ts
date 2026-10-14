/**
 * ISS-1389 — credentials stored verbatim before the transition withheld them are scrubbed once, on
 * deploy: activity rows, the transition log and question text are rewritten to what the withhold
 * path writes today, counted, and a row the scrub cannot represent aborts it by name.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_SCRUB_KEY,
  runCredentialScrubOnce,
  scrubStoredCredentials,
} from '../../src/db/scrub-stored-credentials.js';
import {
  anIssue,
  PASSWORD,
  SHORT,
  storeCredentials,
  USERNAME,
} from '../helpers/comment-credential-fixture.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import { setupTestDatabase, type TestDatabase, truncateAll } from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let raw: postgres.Sql<Record<string, never>>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  raw = harness.client as unknown as postgres.Sql<Record<string, never>>;
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
});

const LEAK = `the ${USERNAME} account is locked and ${PASSWORD} fails`;

async function activity(issueId: string, action: string, payload: unknown): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload)
    VALUES (${id}, ${issueId}, 'user', ${ownerId}, ${action}, ${JSON.stringify(payload)}::jsonb)`);
  return id;
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const [row] = (await harness.db.execute(
    sql`SELECT payload FROM activity_log WHERE id = ${id}`,
  )) as unknown as Array<{ payload: Record<string, unknown> }>;
  return row?.payload ?? {};
}

async function kernel(issueId: string, reason: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, reason, actor_type, source)
    VALUES (${id}, 'issue', ${issueId}, 'open', 'needs_info', ${reason}, 'user', 'issues')`);
  return id;
}

async function outbox(issueId: string, project: string, reason: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_outbox (id, issue_id, project_id, from_status, to_status, reason)
    VALUES (${id}, ${issueId}, ${project}, 'open', 'needs_info', ${reason})`);
  return id;
}

async function question(issueId: string, steps: unknown, voidReason: string | null) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, blocker_kind, steps, void_reason)
    VALUES (${id}, ${projectId}, ${issueId}, 'human', ${JSON.stringify(steps)}::jsonb, ${voidReason})`);
  return id;
}

async function textOf(table: 'kernel_transitions' | 'pipeline_outbox', id: string) {
  const rows = (await harness.db.execute(
    sql`SELECT reason FROM ${sql.identifier(table)} WHERE id = ${id}`,
  )) as unknown as Array<{ reason: string }>;
  return rows[0]?.reason;
}

const step = (prompt: string, needed: string, answerText?: string) => ({
  round: 1,
  prompt,
  askedAt: '2026-10-01T00:00:00Z',
  answerShape: 'free_text',
  needed,
  ...(answerText ? { answerText } : {}),
});

describe('the stored-credential scrub', () => {
  it('rewrites each surface to the withheld text, counts it, and leaves everything else as stored', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await anIssue(harness.db, projectId, ownerId);
    const moved = await activity(here, 'issue.statusChanged', {
      from: 'open',
      to: 'needs_info',
      reason: LEAK,
    });
    const posted = await activity(here, 'comment.created', {
      commentId: 'c',
      body: `pw ${PASSWORD}`,
    });
    const edited = await activity(here, 'comment.updated', {
      commentId: 'c',
      before: 'old words',
      after: USERNAME,
    });
    const plain = await activity(here, 'issue.statusChanged', {
      from: 'open',
      to: 'needs_info',
      reason: `the ${SHORT} build`,
    });
    const created = await activity(here, 'issue.created', { snapshot: { title: USERNAME } });
    const k = await kernel(here, LEAK);
    const o = await outbox(here, projectId, LEAK);
    const q = await question(
      here,
      [step(LEAK, `the ${PASSWORD} reset`, `it is ${USERNAME}`)],
      `voided: ${USERNAME}`,
    );

    const other = (await createTestProject(harness.db, ownerId)).id;
    const elsewhere = await anIssue(harness.db, other, ownerId);
    const untouched = await activity(elsewhere, 'issue.statusChanged', {
      from: 'open',
      to: 'needs_info',
      reason: LEAK,
    });

    const done = await runCredentialScrubOnce(raw);

    expect(done).toEqual({
      ran: true,
      report: { activity: 3, kernelTransitions: 1, outbox: 1, questions: 1 },
    });
    const reason = (await payloadOf(moved)).reason as string;
    expect(reason).toMatch(
      /^the \[withheld: test credential "staging admin".+\] account is locked and \[withheld: .+\] fails$/,
    );
    expect(await payloadOf(posted)).toEqual({
      commentId: 'c',
      body: expect.stringMatching(/^pw \[withheld: /),
    });
    expect(await payloadOf(edited)).toEqual({
      commentId: 'c',
      before: 'old words',
      after: expect.stringMatching(/^\[withheld: /),
    });
    expect(await textOf('kernel_transitions', k)).toBe(reason);
    expect(await textOf('pipeline_outbox', o)).toBe(reason);
    const [asked] = (await harness.db.execute(
      sql`SELECT steps, void_reason FROM agent_questions WHERE id = ${q}`,
    )) as unknown as Array<{ steps: Array<Record<string, string>>; void_reason: string }>;
    expect(asked?.steps[0]?.prompt).toBe(reason);
    expect(asked?.steps[0]?.needed).toMatch(/^the \[withheld: .+\] reset$/);
    expect(asked?.steps[0]?.answerText, "a person's answer is theirs").toBe(`it is ${USERNAME}`);
    expect(asked?.void_reason).toMatch(/^voided: \[withheld: /);

    expect((await payloadOf(plain)).reason).toBe(`the ${SHORT} build`);
    expect(await payloadOf(created)).toEqual({ snapshot: { title: USERNAME } });
    expect(
      (await payloadOf(untouched)).reason,
      'a project with no credentials keeps its rows',
    ).toBe(LEAK);
  });

  it('runs once: the marker it writes stops a second deploy, and a second pass finds nothing', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await anIssue(harness.db, projectId, ownerId);
    await activity(here, 'issue.statusChanged', { reason: LEAK });

    expect((await runCredentialScrubOnce(raw)).ran).toBe(true);
    expect(await runCredentialScrubOnce(raw)).toEqual({ ran: false });
    const marker = (await harness.db.execute(
      sql`SELECT key FROM backfill_markers WHERE key = ${CREDENTIAL_SCRUB_KEY}`,
    )) as unknown as unknown[];
    expect(marker).toHaveLength(1);
    expect(await scrubStoredCredentials(raw)).toEqual({
      activity: 0,
      kernelTransitions: 0,
      outbox: 0,
      questions: 0,
    });
  });

  it('aborts naming a row it cannot represent, and rewrites nothing', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await anIssue(harness.db, projectId, ownerId);
    const leak = await activity(here, 'issue.statusChanged', { reason: LEAK });
    const odd = await activity(here, 'comment.created', { body: 42 });

    await expect(runCredentialScrubOnce(raw)).rejects.toThrow(
      `activity_log ${odd} (comment.created) holds a number at payload.body`,
    );
    expect((await payloadOf(leak)).reason).toBe(LEAK);
    const marker = (await harness.db.execute(
      sql`SELECT key FROM backfill_markers WHERE key = ${CREDENTIAL_SCRUB_KEY}`,
    )) as unknown as unknown[];
    expect(marker).toEqual([]);
  });

  it('aborts naming a question whose steps are not a list', async () => {
    await storeCredentials(harness.db, projectId);
    const here = await anIssue(harness.db, projectId, ownerId);
    const q = await question(here, { prompt: LEAK }, null);
    await expect(runCredentialScrubOnce(raw)).rejects.toThrow(
      `agent_questions ${q} has steps that are not a list`,
    );
  });

  it('writes the marker and rewrites nothing where no project stores credentials', async () => {
    const here = await anIssue(harness.db, projectId, ownerId);
    const kept = await activity(here, 'issue.statusChanged', { reason: LEAK });
    expect(await runCredentialScrubOnce(raw)).toEqual({
      ran: true,
      report: { activity: 0, kernelTransitions: 0, outbox: 0, questions: 0 },
    });
    expect((await payloadOf(kept)).reason).toBe(LEAK);
  });
});
