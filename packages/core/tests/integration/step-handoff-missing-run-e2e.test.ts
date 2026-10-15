/**
 * ISS-1319 — a handoff write naming a pipeline run that does not exist is refused by name at both
 * doors. The row's foreign key to `pipeline_runs` is what refused it, and nothing turned that into
 * an answer: REST said a bare 500 `INTERNAL_ERROR` and the tool a bare internal error, naming
 * neither the field nor the cause.
 *
 * Integration because the refusal being replaced is a Postgres foreign-key violation, which only a
 * real insert raises.
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
let issueId: string;
let ownRun: string;
let foreignRun: string;
let member: Caller;

const payload = {
  step: 'triage',
  schema_version: 1,
  summary: 'a handoff',
  suggestedApproach: 'none',
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

  const stranger = await createTestUser(harness.db);
  const otherProject = (await createTestProject(harness.db, stranger.id)).id;
  issueId = randomUUID();
  ownRun = randomUUID();
  foreignRun = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'mine', 'open', ${seeded.ownerId})`);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${ownRun}, ${projectId}, 'interactive', 'running'),
           (${foreignRun}, ${otherProject}, 'interactive', 'running')`);
});

async function handoffRows(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM run_journal WHERE issue_id = ${issueId} AND handoff IS NOT NULL`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

type Write = (pipelineRunId: string) => Promise<Door & { status?: number }>;

const writes: Record<string, Write> = {
  'REST POST /api/issue-step-contexts': (pipelineRunId) =>
    callRest(server.baseUrl, member.jwt, 'POST', '/api/issue-step-contexts', {
      projectId,
      issueId,
      pipelineRunId,
      step: 'triage',
      payload,
    }),
  'forge_step_handoff.write': (pipelineRunId) =>
    callTool(member.pat, 'forge_step_handoff.write', {
      projectId,
      issueId,
      pipelineRunId,
      step: 'triage',
      payload,
    }),
};

describe.each(Object.entries(writes))('a handoff write through %s', (name, write) => {
  it('refuses a run that does not exist by naming pipelineRunId and that no such run exists', async () => {
    const missing = randomUUID();
    const answer = await write(missing);
    expect(answer.refused, 'a missing run must be refused, not written').toBeDefined();
    expect(answer.refused).toContain('pipelineRunId');
    expect(answer.refused).toContain(missing);
    expect(answer.refused).toContain('no such run exists');
    expect(answer.refused).not.toContain('INTERNAL_ERROR');
    if (name.startsWith('REST')) expect(answer.status).toBe(404);
    expect(await handoffRows()).toBe(0);
  });

  it("refuses another project's run in the same words, so it neither writes nor says the run exists", async () => {
    const answer = await write(foreignRun);
    expect(answer.refused).toContain('no such run exists');
    expect(await handoffRows()).toBe(0);
  });

  it("admits a run of the issue's own project", async () => {
    const answer = await write(ownRun);
    expect(answer).not.toHaveProperty('refused');
    expect(await handoffRows()).toBe(1);
  });
});
