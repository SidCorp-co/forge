/**
 * The prompt preview is the prompt a claimed job is given (e2e D3, ISS-53/57): for an issue that
 * builds an approved design and delivers an agreed requirement with a baseline pin,
 * `POST /api/prompts/preview` answers the same system prompt and the same measured blocks as
 * `prepareJobForMaster`, including `artifact-context` with the requirement's criteria and pins,
 * and the preview writes no session.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let server: TestServer;
let claim: typeof import('../../src/devices/claim.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  claim = await import('../../src/devices/claim.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

/** A bound box, an open issue with a queued `drive` job, building an approved design and delivering REQ-1 r1. */
async function seed() {
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const issue = randomUUID();
  const job = randomUUID();
  const run = randomUUID();
  const workflowId = randomUUID();
  const requirementId = randomUUID();
  const doc = JSON.parse(
    readFileSync(
      new URL('../../src/workflows/fixtures/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  doc.project = project.id;
  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, repo_path)
    VALUES (${randomUUID()}, ${project.id}, ${device.id}, 'claude-code', 'pool-runner', 'online',
            now(), '/tmp/preview-matches-prepare')
  `);
  await harness.db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document,
                                   design_status, approved_revision, written_by_user)
    VALUES (${workflowId}, ${project.id}, 'post-discharge', 'flow', 'designed', 1,
            ${JSON.stringify(doc)}::jsonb, 'approved', 1, ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user,
                                          decision, decided_by_user, decided_at)
    VALUES (${workflowId}, 1, ${JSON.stringify(doc)}::jsonb, ${owner.id}, 'approve', ${owner.id}, now())
  `);
  await harness.db.execute(sql`
    INSERT INTO requirements (id, project_id, req_seq, title, status, current_revision, owner_id)
    VALUES (${requirementId}, ${project.id}, 1, 'Discharge follow-up', 'draft', NULL, ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id,
                                       decided_by, decided_at, tldr)
    VALUES (${requirementId}, 1, 'current', '{"goal":"PREVIEW_GOAL_MARK"}'::jsonb, 'first',
            ${owner.id}, ${owner.id}, now(), 'follow every discharged patient up')
  `);
  await harness.db.execute(sql`
    UPDATE requirements SET status = 'agreed', current_revision = 1 WHERE id = ${requirementId}
  `);
  await harness.db.execute(sql`
    INSERT INTO requirement_criteria (requirement_id, code, body, since_revision) VALUES
      (${requirementId}, 'BC-1', 'PREVIEW_CRITERION_ONE is called within two days', 1),
      (${requirementId}, 'BC-2', 'PREVIEW_CRITERION_TWO is recorded on the case', 1)
  `);
  await harness.db.execute(sql`
    INSERT INTO requirement_baselines (requirement_id, revision, agreed_by, reason)
    VALUES (${requirementId}, 1, ${owner.id}, 'agreed')
  `);
  await harness.db.execute(sql`
    INSERT INTO requirement_baseline_pins (requirement_id, revision, workflow_id, design_revision)
    VALUES (${requirementId}, 1, ${workflowId}, 1)
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id,
                        requirement_id, planned_revision, plan)
    VALUES (${issue}, ${project.id}, 7, 'build post-discharge', 'open', 'high', ${owner.id},
            ${requirementId}, 1, 'build it against r1')
  `);
  await harness.db.execute(sql`
    INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
    VALUES (${issue}, ${workflowId}, ${project.id}, ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${run}, ${project.id}, ${issue}, 'issue', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at,
                      payload)
    VALUES (${job}, ${project.id}, ${issue}, ${run}, 'drive', 'queued', ${owner.id},
            now() - interval '30 minutes', '{"promptString":"do the step"}'::jsonb)
  `);
  return { owner, project, device, issue, job };
}

const sessionCount = async (projectId: string) => {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
};

describe('the prompt preview is the prompt a claimed job is given', () => {
  it('answers the same system prompt and blocks as prepare, artifact-context included, and writes no session', async () => {
    const w = await seed();
    const token = await signUserToken(w.owner.id);

    const res = await fetch(`${server.baseUrl}/api/prompts/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: w.project.id, state: 'drive', issueId: w.issue }),
    });
    const preview = (await res.json()) as Doc;
    expect(res.status, JSON.stringify(preview)).toBe(200);
    expect(await sessionCount(w.project.id)).toBe(0);

    const ids = (preview.blocks as Doc[]).map((b) => b.id);
    expect(ids).toContain('artifact-context');
    expect(ids).toContain('content-language');
    expect(preview.systemPrompt).toContain('REQ-1');
    expect(preview.systemPrompt).toContain('BC-1');
    expect(preview.systemPrompt).toContain('PREVIEW_CRITERION_TWO');
    expect(preview.systemPrompt).toContain('`post-discharge` at approved revision 1');

    const prepared = await claim.prepareJobForMaster({
      jobId: w.job,
      deviceId: w.device.id,
      sessionId: randomUUID(),
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;

    expect(preview.systemPrompt).toBe(prepared.prepared.systemPrompt);
    const snapshot = (await harness.db.execute(
      sql`SELECT prompt_blocks FROM jobs WHERE id = ${w.job}`,
    )) as unknown as Array<{ prompt_blocks: Doc[] }>;
    expect(preview.blocks).toEqual(snapshot[0]?.prompt_blocks);

    const meta = (await harness.db.execute(sql`
      SELECT metadata FROM agent_sessions WHERE metadata->>'jobId' = ${w.job} LIMIT 1
    `)) as unknown as Array<{ metadata: Doc }>;
    expect(meta[0]?.metadata.artifactContext).toMatchObject({
      source: 'workflow-builds+requirement',
    });
    expect(meta[0]?.metadata.contentLanguage).toBeTruthy();
  });
});
