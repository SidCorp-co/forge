/**
 * ISS-1372 — a step handoff is written against the project that owns the issue, whichever door
 * the write comes in by.
 *
 * The store upserts on `(issueId, step, attempt)` and carries no project in that key, so a write
 * authorised against project A that names an issue of project B replaced B's handoff. Both
 * `POST /api/issue-step-contexts` and `forge_step_handoff.write` call the one store; this file
 * names a foreign issue through each and reads B's row back.
 *
 * The phase journal is the other half of the same surface: `POST /api/pipeline-runs/:id/phases`
 * files a phase under the run's own issue when the caller names none, and `forge_phase` start
 * filed it under no issue at all, which a read of the journal by issue then missed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Caller, callRest, callTool, type Door, seedRoles } from '../helpers/door-parity.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownIssue: string;
let ownerId: string;
let foreignIssue: string;
let runId: string;
let member: Caller;

const OLD = { step: 'triage', schema_version: 1, summary: 'the victim row' };
const payload = {
  step: 'triage',
  schema_version: 1,
  summary: 'written by someone else',
  suggestedApproach: 'overwrite it',
  complexity: 'xs',
  risks: [],
  affectedAreas: [],
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  member = seeded.callers.member;
  ownerId = seeded.ownerId;

  const stranger = await createTestUser(harness.db);
  const otherProject = (await createTestProject(harness.db, stranger.id)).id;
  ownIssue = randomUUID();
  foreignIssue = randomUUID();
  runId = randomUUID();
  const foreignRun = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${ownIssue}, ${projectId}, 1, 'mine', 'open', ${seeded.ownerId}),
           (${foreignIssue}, ${otherProject}, 1, 'theirs', 'open', ${stranger.id})`);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running'),
           (${foreignRun}, ${otherProject}, 'interactive', 'running')`);
  await harness.db.execute(sql`
    INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, attempt, payload)
    VALUES (${otherProject}, ${foreignIssue}, ${foreignRun}, 'handoff', 'triage', 1, ${JSON.stringify(OLD)}::jsonb)`);
});

async function victimPayload(): Promise<unknown> {
  const rows = (await harness.db.execute(
    sql`SELECT payload FROM issue_step_contexts WHERE issue_id = ${foreignIssue}`,
  )) as unknown as Array<{ payload: unknown }>;
  return rows[0]?.payload;
}

type Write = (issueId: string) => Promise<Door>;

const writes: Record<string, Write> = {
  'REST POST /api/issue-step-contexts': (issueId) =>
    callRest(server.baseUrl, member.jwt, 'POST', '/api/issue-step-contexts', {
      projectId,
      issueId,
      pipelineRunId: runId,
      step: 'triage',
      payload,
    }),
  'forge_step_handoff.write': (issueId) =>
    callTool(member.pat, 'forge_step_handoff.write', {
      projectId,
      issueId,
      pipelineRunId: runId,
      step: 'triage',
      payload,
    }),
};

describe.each(Object.entries(writes))('a handoff write through %s', (_name, write) => {
  it("refuses an issue of another project by name and leaves that issue's handoff as it was", async () => {
    const { refused } = await write(foreignIssue);
    expect(refused, 'a write against project A must not reach an issue of project B').toBeDefined();
    expect(refused).toContain('does not belong to the project');
    expect(await victimPayload()).toEqual(OLD);
  });

  it('admits an issue of its own project', async () => {
    expect(await write(ownIssue)).not.toHaveProperty('refused');
  });
});

describe('a phase started without naming an issue', () => {
  const issueOfRun = randomUUID();
  const run = randomUUID();

  beforeEach(async () => {
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueOfRun}, ${projectId}, 2, 'the run issue', 'open', ${ownerId})`);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${run}, ${projectId}, ${issueOfRun}, 'issue', 'running')`);
  });

  async function journalIssue(): Promise<string | null | undefined> {
    const rows = (await harness.db.execute(
      sql`SELECT issue_id FROM phase_journal WHERE run_id = ${run}`,
    )) as unknown as Array<{ issue_id: string | null }>;
    return rows[0] ? rows[0].issue_id : undefined;
  }

  const starts: Record<string, () => Promise<Door>> = {
    'REST POST /api/pipeline-runs/:id/phases': () =>
      callRest(server.baseUrl, member.jwt, 'POST', `/api/pipeline-runs/${run}/phases`, {
        phase: 'plan',
      }),
    'forge_phase start': () =>
      callTool(member.pat, 'forge_phase', {
        action: 'start',
        projectId,
        runId: run,
        phase: 'plan',
      }),
  };

  it.each(Object.entries(starts))(
    'is filed under the issue of its run by %s',
    async (_name, start) => {
      expect(await start()).not.toHaveProperty('refused');
      expect(await journalIssue()).toBe(issueOfRun);
    },
  );
});
