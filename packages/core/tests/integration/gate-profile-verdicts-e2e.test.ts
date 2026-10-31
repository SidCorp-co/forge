/**
 * REQ-76 BC-7: under yolo the builder's own verdict counts, and a release needs no person's
 * approval. The same project under standard keeps today's rule: with `qa: independent` the building
 * run's pass is kept but never counts (VERDICT_BY_BUILDER, independent-qa-verdict-e2e), and with
 * `release.approval.required` a release run with no approval makes no production act
 * (RELEASE_APPROVAL_REQUIRED), its refusal naming the gate that holds it (BC-11). The profile is
 * set through the gates door (BC-12). Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/criteria/verdict-record.ts
 * @direct-test-of packages/core/src/release-batch/approvals.ts
 * @direct-test-of packages/core/src/project-config/gates.ts
 */

import { randomUUID } from 'node:crypto';
import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUE_STATUSES_METADATA_KEY,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { DEFAULT_POLICY } from '../../src/project-config/default-policy.js';
import { api, userToken } from '../helpers/api.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const NEW = '2222222222222222222222222222222222222222';
const LIVE = '9999999999999999999999999999999999999999';

let projectId: string;
let ownerId: string;
let token: string;
let box: string;
let boxToken: string;
let seq = 0;
let unplant: (() => void) | null = null;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (
    await createTestProject(ownerId, { policy: { ...DEFAULT_POLICY, qa: 'independent' } })
  ).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  box = await createTestDevice(ownerId);
  boxToken = (await mintPat({ permissions: ['*'], userId: ownerId, name: 'box', deviceId: box }))
    .plaintext;
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
    extra: { release: { approval: { required: true } } } as never,
  });
  unplant = plantLiveBuild(LIVE, { [NEW]: true });
});

afterEach(() => {
  unplant?.();
  unplant = null;
});

async function ok(r: Promise<{ status: number; body: unknown }>): Promise<Doc> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
}

const onProject = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

/** The project's gate profile, through the gates door with a reason, as a person sets it. */
async function profile(
  name: 'standard' | 'yolo',
  overrides: Record<string, string> = {},
): Promise<void> {
  const read = await ok(onProject('GET', '/gates'));
  await ok(
    onProject('PUT', '/gates', {
      baseRevision: read.revision,
      profile: name,
      overrides,
      reason: `planted: ${name} for the verdict and approval test`,
    }),
  );
}

async function agreedRequirement(): Promise<string> {
  const created = await ok(
    onProject('POST', '/requirements', {
      title: 'Reminders',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(onProject('POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(
    onProject('POST', `/requirements/${key}/revisions/1/accept`, {
      reason: 'Accepted for this test.',
    }),
  );
  await ok(
    onProject('POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    }),
  );
  return key;
}

/** An in_progress issue delivering `req`, criterion 2 a code property traced to BC-2. */
async function issueTracing(req: string): Promise<{ id: string; key: string }> {
  seq += 1;
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await ok(onProject('POST', `/requirements/${req}/issues`, { issue: issue.key }));
  await ok(
    api(token, 'POST', `/api/issues/${issue.id}/criteria/traces`, { codes: ['BC-1', 'BC-2'] }),
  );
  await ok(
    api(token, 'PUT', `/api/issues/${issue.id}/design`, {
      criteria: [
        { criterion: 1, class: 'observable', pattern: null, proof: 'the reminders probe' },
        { criterion: 2, class: 'code_property', pattern: null, proof: 'the review reads the diff' },
      ],
      modules: [],
      contracts: [],
    }),
  );
  return issue;
}

/** The building run: a run session on the box declared over `key` while it stood open, holding its lease. */
async function buildingRun(key: string): Promise<void> {
  const runId = randomUUID();
  const metadata = {
    boxRunId: randomUUID(),
    [RUN_GROUP_METADATA_KEY]: [key],
    [RUN_ISSUE_STATUSES_METADATA_KEY]: { [key]: 'open' },
  };
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', now(), ${JSON.stringify(metadata)}::jsonb)`);
  const [s] = await rows<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at)
    VALUES (${projectId}, ${box}, ${runId}, 'run_session', 'running', now() - interval '1 minute', now() - interval '1 minute')
    RETURNING id`);
  if (!s) throw new Error('no run session seeded');
  await db.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    VALUES (${projectId}, ${key}, ${box}, ${s.id}, ${runId})`);
  // its work lands at NEW after it took the issue, so it is the builder of what landed
  await db.execute(sql`
    UPDATE issues SET merged_at = now(), merged_commit_sha = ${NEW}
     WHERE project_id = ${projectId} AND iss_seq = ${Number(key.split('-')[1])}`);
}

/** The builder's pass on the code-property criterion. */
const builderPass = (issueId: string) =>
  ok(
    api(boxToken, 'POST', `/api/issues/${issueId}/verdicts`, {
      criterion: 2,
      verdict: 'pass',
      reason: 'pass on the running build',
      identity: { kind: 'commit', sha: NEW },
      evidence: ['diff.txt'],
      judge: 'review',
    }),
  );

async function bc2(req: string): Promise<{ verdict: string; notCounted: string | null }> {
  const d = (await ok(onProject('GET', `/requirements/${req}`))) as {
    standing: {
      coverage: { code: string; verdict: string; issues: { notCounted: string | null }[] }[];
    };
  };
  const row = d.standing.coverage.find((c) => c.code === 'BC-2');
  return { verdict: String(row?.verdict), notCounted: row?.issues[0]?.notCounted ?? null };
}

describe("REQ-76 BC-7: the builder's own verdict", () => {
  // REQ-79 r6: builder_verdict is strict's now; standard counts it unless the project enforces it
  it('standard counts it: the write names nothing uncounted and the BC reads passing', async () => {
    await profile('standard');
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await buildingRun(issue.key);
    const res = await builderPass(issue.id);
    expect(res.notCounted).toBeNull();
    expect(await bc2(req)).toEqual({ verdict: 'passing', notCounted: null });
  });

  it('standard with builder_verdict enforced keeps it uncounted, named VERDICT_BY_BUILDER', async () => {
    await profile('standard', { builder_verdict: 'enforce' });
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await buildingRun(issue.key);
    const res = await builderPass(issue.id);
    expect(res.notCounted).toMatchObject({ code: 'VERDICT_BY_BUILDER' });
    expect(await bc2(req)).toEqual({
      verdict: 'not_judged',
      notCounted:
        "passed by the run that built it, and a builder's own pass never counts where gate builder_verdict is enforced (gates.overrides.builder_verdict relaxes it)",
    });
  });

  it('yolo counts it: the write names nothing uncounted and the BC reads passing', async () => {
    const req = await agreedRequirement();
    const issue = await issueTracing(req);
    await buildingRun(issue.key);
    await profile('yolo');
    const res = await builderPass(issue.id);
    expect(res.notCounted).toBeNull();
    expect(await bc2(req)).toEqual({ verdict: 'passing', notCounted: null });
  });
});

describe('REQ-76 BC-7: a release needs no person approval under yolo', () => {
  const attempt = async (): Promise<unknown> => {
    const { assertApprovalAllowsAttempt } = await import('../../src/release-batch/approvals.js');
    try {
      await assertApprovalAllowsAttempt(randomUUID(), projectId);
      return null;
    } catch (err) {
      return err;
    }
  };

  it('standard with release.approval.required refuses a run with no approval, naming the gate', async () => {
    await profile('standard');
    const err = (await attempt()) as { refusals?: { code: string; detail: string }[] } | null;
    expect(err?.refusals?.map((r) => r.code)).toEqual(['RELEASE_APPROVAL_REQUIRED']);
    expect(err?.refusals?.[0]?.detail).toContain(
      "Gate release_approval is enforced by this project's release.approval.required setting, which its gate profile standard defers to",
    );
  });

  it('yolo lets the same run make its production act with no approval asked', async () => {
    await profile('yolo');
    expect(await attempt()).toBeNull();
  });
});
