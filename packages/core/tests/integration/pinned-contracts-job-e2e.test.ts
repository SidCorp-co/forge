/**
 * REQ-5 BC-12 (ISS-1174): a job on an issue that delivers a requirement is given the contract
 * versions its requirement's latest baseline pins, and is refused by name when a pinned version
 * cannot be loaded (`ARTIFACT_CONTEXT_UNLOADABLE`) or is no longer current
 * (`REQUIREMENT_REVISION_NOT_CURRENT`); a contract version named only in the issue's text is not
 * loaded. Each job is claimed and prepared as a box's claim prepares it, against real Postgres.
 *
 * @direct-test-of packages/core/src/workflows/pinned-contracts.ts
 * @direct-test-of packages/core/src/workflows/run-context-service.ts
 * @direct-test-of packages/core/src/jobs/job-system-prompt.ts
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db as dbClient } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { prepareClaimedJob } from '../../src/jobs/prepare-claimed-job.js';
import { refusalCodeOf } from '../../src/lib/refusal.js';
import { api, userToken } from '../helpers/api.js';
import { seedContractVersion } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';

const ARTIFACT = 'openapi: 3.1.0\ninfo: { title: orders, version: 1.2.0 }\npaths: { /orders: {} }';

const w = { projectId: '', slug: '', owner: '', token: '', deviceId: '', requirement: '' };

type Prepared = Awaited<ReturnType<typeof prepareClaimedJob>>;

const db = (statement: ReturnType<typeof sql>) => rows(statement);

async function ok(r: Promise<{ status: number; body: Record<string, unknown> }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

const onProject = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(w.token, method, `/api/projects/${w.projectId}${path}`, body);

/** A version of `contract` recorded strictly after the one before it, so "newest" is never a tie. */
async function version(
  contract: string,
  v: string,
  approval: 'approved' | 'proposed' = 'approved',
): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
  await seedContractVersion({
    providerId: w.projectId,
    ref: `${w.slug}/${contract}`,
    version: v,
    approval,
  });
}

/** Stores `text` as the artifact of `contract@v`, as an upload stores it. */
async function storeArtifact(contract: string, v: string, text: string): Promise<void> {
  const sha = createHash('sha256').update(text).digest('hex');
  await db(sql`
    INSERT INTO contract_artifacts (sha256, content, byte_length)
    VALUES (${sha}, ${text}, ${Buffer.byteLength(text)})`);
  await db(sql`
    UPDATE contract_versions SET artifact_sha256 = ${sha}
     WHERE provider_project_id = ${w.projectId} AND contract_slug = ${contract} AND version = ${v}`);
}

/** REQ-1, linked to the contract `api` and agreed: its baseline pins the version current now. */
async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Order history',
      reason: 'planted',
      criteria: [{ body: 'A shopper sees every past order' }],
    }),
  );
  const key = String(created.key);
  const seq = Number(key.slice(4));
  // the link route asks the project's interface to name the contract; the interface is not what
  // this rule reads, so the link is planted as the route would write it
  await db(sql`
    INSERT INTO requirement_contracts (requirement_id, provider_project_id, contract_slug, linked_by)
    SELECT id, ${w.projectId}, 'api', ${w.owner} FROM requirements
     WHERE project_id = ${w.projectId} AND req_seq = ${seq}`);
  await makeAgreeReady(w.projectId, seq, w.owner);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(onProject('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'Accepted.' }));
  await ok(onProject('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'Agreed.' }));
  return key;
}

/** The contract versions `key`'s latest baseline pins, as `<contract>@<version>`. */
async function pinned(key: string): Promise<string[]> {
  const got = await db(sql`
    SELECT p.contract_slug || '@' || p.contract_version AS pin
      FROM requirement_baseline_pins p JOIN requirements r ON r.id = p.requirement_id
     WHERE r.project_id = ${w.projectId} AND r.req_seq = ${Number(key.slice(4))}
       AND p.contract_slug IS NOT NULL
     ORDER BY p.contract_slug`);
  return got.map((r) => String((r as { pin: string }).pin));
}

/** An issue whose description names `named` in its text, delivering `requirement` where given. */
async function issueNaming(seq: number, named: string, requirement?: string): Promise<string> {
  const { id } = await createTestIssue(w.projectId, w.owner, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await db(sql`
    UPDATE issues SET description = ${`Build the order history call against ${named}.`}
     WHERE id = ${id}`);
  if (requirement) {
    await ok(onProject('POST', `/requirements/${requirement}/issues`, { issue: `ISS-${seq}` }));
  }
  return id;
}

/** A `drive` job on `issueId`, claimed on the box and prepared as the claim prepares it. */
async function claim(issueId: string): Promise<Prepared> {
  // an issue holds one live job: an earlier claim's ends before the next is queued
  await withKernelMarker(dbClient, (tx) =>
    tx.execute(sql`
      UPDATE jobs SET status = 'cancelled' WHERE issue_id = ${issueId} AND status = 'queued'`),
  );
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO pipeline_runs (project_id, kind, status) VALUES (${w.projectId}, 'system', 'running')
    RETURNING id`);
  const [job] = await rows<{ id: string }>(sql`
    INSERT INTO jobs (project_id, issue_id, pipeline_run_id, created_by, type, payload, status)
    VALUES (${w.projectId}, ${issueId}, ${run?.id}, ${w.owner}, 'drive',
            ${JSON.stringify({ promptString: 'Work the issue.' })}::jsonb, 'queued')
    RETURNING id`);
  const policy = {
    revision: 1,
    qa: 'none',
    status: 'in_progress',
    from: 'job',
    model: 'opus',
    profile: 'default',
    deniedTools: [],
  };
  return prepareClaimedJob({
    jobId: job?.id as string,
    deviceId: w.deviceId,
    policy: policy as unknown as Parameters<typeof prepareClaimedJob>[0]['policy'],
  });
}

/** Why the claim of a job on `issueId` was refused: its code and its sentence. */
async function refusedClaim(issueId: string): Promise<{ code: string | null; said: string }> {
  try {
    await claim(issueId);
  } catch (err) {
    return { code: refusalCodeOf(err), said: err instanceof Error ? err.message : String(err) };
  }
  throw new Error(`the job on ${issueId} was prepared, and a refusal was expected`);
}

/** The contract versions the job's session records it was given. */
async function recordedOn(sessionId: string): Promise<unknown[] | undefined> {
  const [row] = await rows<{ contracts: unknown[] | null }>(sql`
    SELECT metadata -> 'artifactContext' -> 'contracts' AS contracts
      FROM agent_sessions WHERE id = ${sessionId}`);
  return row?.contracts ?? undefined;
}

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  const project = await createTestProject(owner.id);
  w.projectId = project.id;
  w.slug = project.slug;
  w.owner = owner.id;
  w.token = await userToken(owner.id);
  await addProjectMember(w.projectId, owner.id, 'owner');
  await addProjectMember(w.projectId, agent.id, 'member');
  w.deviceId = (await pairTestBox(w.projectId, { pairedBy: owner.id, actsAs: agent.id })).deviceId;
  await version('api', '1.1.0');
  await version('api', '1.2.0');
  await storeArtifact('api', '1.2.0', ARTIFACT);
  // a second contract the issue's text names and no baseline pins
  await version('events', '2.0.0');
  w.requirement = await agreedRequirement();
  expect(await pinned(w.requirement)).toEqual(['api@1.2.0']);
});

describe('BC-12 a job is given the contract versions its requirement pins', () => {
  it('(a) gives the pinned version whole, and records it on the job session', async () => {
    const issueId = await issueNaming(1, `${w.slug}/api@1.2.0`, w.requirement);
    const prepared = await claim(issueId);
    expect(prepared.systemPrompt).toContain(
      `## The contract versions ${w.requirement}'s latest baseline pins`,
    );
    expect(prepared.systemPrompt).toContain(`### ${w.slug}/api@1.2.0 (openapi)`);
    expect(prepared.systemPrompt).toContain(ARTIFACT);
    expect(await recordedOn(prepared.agentSessionId)).toEqual([
      {
        kind: 'contract-version',
        ref: `${w.slug}/api`,
        version: '1.2.0',
        sha256: createHash('sha256').update(ARTIFACT).digest('hex'),
        chars: ARTIFACT.length,
      },
    ]);
  });

  it('(d) does not load a version named only in the issue text, beside the pinned one', async () => {
    const issueId = await issueNaming(
      1,
      `${w.slug}/api@1.1.0 and ${w.slug}/events@2.0.0`,
      w.requirement,
    );
    const prepared = await claim(issueId);
    expect(prepared.systemPrompt).toContain(`### ${w.slug}/api@1.2.0 (openapi)`);
    expect(prepared.systemPrompt).not.toContain(`### ${w.slug}/api@1.1.0`);
    expect(prepared.systemPrompt).not.toContain(`### ${w.slug}/events@2.0.0`);
    expect(
      ((await recordedOn(prepared.agentSessionId)) ?? []).map((c) => (c as { ref: string }).ref),
    ).toEqual([`${w.slug}/api`]);
  });

  it('(d) gives an issue delivering no requirement no contract version, whatever its text names', async () => {
    const issueId = await issueNaming(2, `${w.slug}/api@1.2.0`);
    const prepared = await claim(issueId);
    expect(prepared.systemPrompt).not.toContain('latest baseline pins');
    expect(prepared.systemPrompt).not.toContain(`### ${w.slug}/api@`);
    expect(await recordedOn(prepared.agentSessionId)).toBeUndefined();
  });
});

describe('BC-12 a job whose pinned version cannot be given is refused by name', () => {
  it('(c) refuses REQUIREMENT_REVISION_NOT_CURRENT once a later version is approved', async () => {
    const issueId = await issueNaming(1, `${w.slug}/api@1.2.0`, w.requirement);
    await version('api', '1.3.0', 'proposed');
    expect((await claim(issueId)).systemPrompt, 'a proposed version is not current').toContain(
      `### ${w.slug}/api@1.2.0 (openapi)`,
    );
    await ok(onProject('POST', '/contracts/api/versions/1.3.0/decision', { decision: 'approve' }));
    const refused = await refusedClaim(issueId);
    expect(refused.code, refused.said).toBe('REQUIREMENT_REVISION_NOT_CURRENT');
    expect(refused.said).toContain(
      `contract-version ${w.slug}/api@1.2.0: ${w.requirement}'s latest baseline pins it, and 1.3.0 is the current version now`,
    );
  });

  it('(b) refuses ARTIFACT_CONTEXT_UNLOADABLE where the pinned version is not approved', async () => {
    const issueId = await issueNaming(1, `${w.slug}/api@1.2.0`, w.requirement);
    await version('events', '3.0.0', 'proposed');
    // a pin on a version nobody approved, planted on the latest baseline beside the api pin
    await db(sql`
      INSERT INTO requirement_baseline_pins
        (requirement_id, revision, baseline_seq, provider_project_id, contract_slug, contract_version)
      SELECT requirement_id, revision, baseline_seq, provider_project_id, 'events', '3.0.0'
        FROM requirement_baseline_pins
       WHERE provider_project_id = ${w.projectId} AND contract_slug = 'api'`);
    const refused = await refusedClaim(issueId);
    expect(refused.code).toBe('ARTIFACT_CONTEXT_UNLOADABLE');
    expect(refused.said).toContain(
      `contract-version ${w.slug}/events@3.0.0: ${w.requirement}'s latest baseline pins it, and it is proposed; a job is given approved versions only`,
    );
  });
});
