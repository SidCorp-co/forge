/**
 * ISS-53 (dev) — a claimed build job is given the design revision its approver approved, against a
 * real Postgres: the approved revision is read through `workflow_builds`, carried in the system
 * prompt as a measured block, recorded on the job's session, and a revision that cannot be read
 * refuses the job by name. An issue that builds nothing is untouched, and an issue whose design is
 * not approved is held by the build gate before preparation is reached.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let claim: typeof import('../../src/devices/claim.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  claim = await import('../../src/devices/claim.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const designDoc = (projectId: string): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../../src/workflows/fixtures/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  return d;
};

/** One project, one bound box, one queued `code` job on an open issue. */
async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const issue = randomUUID();
  const run = randomUUID();
  const job = randomUUID();
  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at, repo_path)
    VALUES (${randomUUID()}, ${project.id}, ${device.id}, 'claude-code', 'pool-runner', 'online',
            now(), '/tmp/design-context-test')
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${issue}, ${project.id}, 53, 'build post-discharge', 'open', 'high', ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${run}, ${project.id}, ${issue}, 'issue', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at,
                      payload)
    VALUES (${job}, ${project.id}, ${issue}, ${run}, 'code', 'queued', ${owner.id},
            now() - interval '30 minutes', '{"promptString":"do the step"}'::jsonb)
  `);
  return { owner, project, device, issue, job };
}

/** The issue builds `post-discharge`, whose design is `status` with revision 1 approved or not. */
async function linkDesign(
  w: Awaited<ReturnType<typeof seed>>,
  opts: { approved: boolean; workflowRevision?: number },
) {
  const workflowId = randomUUID();
  const doc = designDoc(w.project.id);
  await harness.db.execute(sql`
    INSERT INTO project_workflows (id, project_id, flow, kind, status, revision, document,
                                   design_status, approved_revision, written_by_user)
    VALUES (${workflowId}, ${w.project.id}, 'post-discharge', 'flow', 'designed',
            ${opts.workflowRevision ?? 1}, ${JSON.stringify(doc)}::jsonb,
            ${opts.approved ? 'approved' : 'proposed'}, ${opts.approved ? 1 : null}, ${w.owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user,
                                          decision, decided_by_user, decided_at)
    VALUES (${workflowId}, 1, ${JSON.stringify(doc)}::jsonb, ${w.owner.id},
            ${opts.approved ? 'approve' : null}, ${opts.approved ? w.owner.id : null},
            ${opts.approved ? sql`now()` : null})
  `);
  await harness.db.execute(sql`
    INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user)
    VALUES (${w.issue}, ${workflowId}, ${w.project.id}, ${w.owner.id})
  `);
  return { workflowId, doc };
}

async function jobState(jobId: string) {
  const rows = (await harness.db.execute(sql`
    SELECT j.status, j.held_by, j.prompt_blocks,
           (SELECT s.metadata FROM agent_sessions s WHERE s.metadata->>'jobId' = j.id::text
            LIMIT 1) AS session_metadata
    FROM jobs j WHERE j.id = ${jobId}
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0] as Doc;
  return {
    status: r.status as string,
    heldBy: r.held_by as string | null,
    blocks: (r.prompt_blocks as Doc[] | null) ?? null,
    session: (r.session_metadata as Doc | null) ?? null,
  };
}

const prepare = (jobId: string, deviceId: string) =>
  claim.prepareJobForMaster({ jobId, deviceId, sessionId: randomUUID() });

describe('a build job is given the approved design its issue builds', () => {
  it('carries the approved revision in the prompt, as a measured block, and records it on the job', async () => {
    const w = await seed();
    const { workflowId, doc } = await linkDesign(w, { approved: true, workflowRevision: 2 });

    const result = await prepare(w.job, w.device.id);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const prompt = result.prepared.systemPrompt;
    expect(prompt).toContain('## The approved design this issue builds');
    expect(prompt).toContain('`post-discharge` at approved revision 1');
    for (const s of doc.steps) expect(prompt).toContain(`- \`${s.id}\``);
    expect(prompt).toContain('"condition":"followup_required == true"');

    const state = await jobState(w.job);
    const block = state.blocks?.find((b) => b.id === 'artifact-context');
    expect(block).toMatchObject({ kind: 'system', chars: expect.any(Number) });
    expect(block?.estTokens).toBeGreaterThan(0);
    expect(state.session?.artifactContext).toMatchObject({
      source: 'workflow-builds',
      artifacts: [
        {
          kind: 'workflow-design',
          ref: 'post-discharge',
          workflowId,
          revision: 1,
          designStatus: 'approved',
          workflowRevision: 2,
          steps: doc.steps.length,
          edges: doc.edges.length,
          cut: { fields: [], steps: [], edges: 0 },
        },
      ],
    });
  });

  it('refuses the job by name when the approved revision cannot be read, and leaves nothing behind', async () => {
    const w = await seed();
    const { workflowId } = await linkDesign(w, { approved: true });
    await harness.db.execute(sql`
      UPDATE project_workflow_designs SET document = '{"version":2,"steps":"unreadable"}'::jsonb
      WHERE workflow_id = ${workflowId}
    `);

    await expect(prepare(w.job, w.device.id)).rejects.toThrow(
      new RegExp(
        `^ARTIFACT_CONTEXT_UNLOADABLE: prepare refused job ${w.job}: .*ARTIFACT_CONTEXT_UNLOADABLE: workflow-design post-discharge@1 \\(workflow ${workflowId}\\)`,
      ),
    );
    const state = await jobState(w.job);
    expect(state).toEqual({ status: 'queued', heldBy: null, blocks: null, session: null });
  });

  it('leaves a job whose issue builds no design exactly as it was', async () => {
    const w = await seed();

    const result = await prepare(w.job, w.device.id);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.systemPrompt).not.toContain('approved design');
    const state = await jobState(w.job);
    expect(state.blocks?.map((b) => b.id)).not.toContain('artifact-context');
    expect(state.session).not.toBeNull();
    expect(state.session).not.toHaveProperty('artifactContext');
  });

  it('never reaches preparation for an issue whose design is not approved: the build gate holds it', async () => {
    const w = await seed();
    await linkDesign(w, { approved: false });

    const result = await prepare(w.job, w.device.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'policy_refused',
      code: 'WORKFLOW_DESIGN_NOT_APPROVED',
    });
    const state = await jobState(w.job);
    expect(state).toEqual({ status: 'queued', heldBy: null, blocks: null, session: null });
  });
});
