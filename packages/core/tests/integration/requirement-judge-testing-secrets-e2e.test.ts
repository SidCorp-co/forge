/**
 * ISS-975: a judge run declared at a requirement (`forge-runner run declare --requirement REQ-n
 * --role qa`, ISS-735) reads the testing secrets `forge-runner judge-login` signs in with. The door
 * named a run's environment only by walking the issues it was declared over, and such a run is
 * declared over none, so every requirement judge was refused TESTING_SECRETS_NOT_LANDED "was
 * declared over no issue" (REQ-35 BC-3 and BC-7, run b2bd9ecb, forge-dev dev.501). It now reads the
 * environment the way the requirement's coverage weighs it: a delivering issue's landing, else
 * `delivery.judgedOn`, else production; the read is audited on the requirement, naming the run and
 * the declarer; and where none can be named the refusal says so and what to declare instead.
 * Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/requirement-run-secrets.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 * @direct-test-of packages/core/src/project-config/judged-environment.ts
 * @direct-test-of packages/core/src/requirements/judge-run-secrets.ts
 * @direct-test-of packages/core/src/devices/declared-run-of-call.ts
 * @direct-test-of packages/core/src/db/schema-requirement-secret-reads.ts
 * @direct-test-of packages/core/src/project-config/ports.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { db } from '../../src/db/client.js';
import { requirementSecretRefsOfSession } from '../../src/requirements/index.js';
import { api } from '../helpers/api.js';
import {
  codeOf,
  landedIssue,
  REF,
  secrets,
  seedDeclaredRunWorld,
  VALUE,
  world,
} from '../helpers/declared-run-secrets-world.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestRequirement, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let requirement = { id: '', key: '' };

beforeEach(async () => {
  await seedDeclaredRunWorld();
  requirement = await createTestRequirement(world.projectId, 35, 'The requirement page');
  const master = await api(world.boxToken, 'POST', '/api/devices/me/master-session', {
    projectId: world.projectId,
    name: 'forge-master-adminhub',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
});

/** `forge-runner run declare --requirement REQ-35 --role qa`: the box opens the run's session at core. */
async function judgeAtRequirement(): Promise<{ boxRunId: string; session: string }> {
  const boxRunId = randomUUID();
  const opened = await api(world.boxToken, 'POST', '/api/devices/me/run-sessions', {
    projectId: world.projectId,
    runId: boxRunId,
    issueKeys: [],
    requirement: requirement.key,
    name: 'req-35-judge',
    role: 'qa',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { boxRunId, session: String((opened.body as Doc).sessionId) };
}

/** ISS-`seq` delivering REQ-35. */
async function delivering(issueId: string): Promise<void> {
  await db.execute(sql`UPDATE issues SET requirement_id = ${requirement.id} WHERE id = ${issueId}`);
}

/** The project's environments: `stg` judged on staging, and what else a case declares. */
async function environments(extra: Record<string, unknown> = {}, judgedOn?: string) {
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
    environments: {
      stg: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        testing: 'stg',
        url: 'https://stg.adminhub.example.test',
      },
      ...extra,
    } as never,
    ...(judgedOn ? { extra: { delivery: { judgedOn } } } : {}),
  });
}

interface ReadRow {
  requirement_id: string;
  session_id: string;
  run_id: string;
  box_run_id: string | null;
  device_id: string;
  declared_by: string | null;
  issue_id: string | null;
  basis: string;
  environment: string;
  profile: string;
  refs: string[];
}

const reads = () => rows<ReadRow>(sql`SELECT * FROM requirement_secret_reads ORDER BY created_at`);

const said = (body: unknown): string => {
  const b = body as { message?: string; error?: { message?: string } };
  return b.error?.message ?? b.message ?? JSON.stringify(body);
};

describe('ISS-975 a judge run declared at a requirement signs in on the environment the requirement is weighed on', () => {
  it("hands the profile's actor login for the environment a delivering issue landed on", async () => {
    const issueId = await landedIssue(world.projectId, 460);
    await delivering(issueId);
    const run = await judgeAtRequirement();

    const res = await secrets(world.boxToken, run.boxRunId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      jobId: null,
      run: { session: run.session },
      environment: 'stg',
      profileId: 'stg',
      secrets: [{ ref: REF, value: VALUE }],
      deployment: { environment: 'stg', url: 'https://stg.adminhub.example.test' },
    });
  });

  it('audits the read on the requirement, naming the run and the declarer, never the value', async () => {
    const issueId = await landedIssue(world.projectId, 461);
    await delivering(issueId);
    const run = await judgeAtRequirement();

    expect((await secrets(world.boxToken, run.boxRunId)).status).toBe(200);

    const audit = await reads();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      requirement_id: requirement.id,
      session_id: run.session,
      box_run_id: run.boxRunId,
      device_id: world.box,
      declared_by: world.ownerId,
      issue_id: issueId,
      basis: 'landing',
      environment: 'stg',
      profile: 'stg',
      refs: [REF],
    });
    expect(JSON.stringify(audit)).not.toContain(VALUE);
    // the scrubber reads the refs this session holds off the same record
    expect(await requirementSecretRefsOfSession(run.session)).toEqual([
      { projectId: world.projectId, refs: [REF] },
    ]);
  });

  it('reads the environment `delivery.judgedOn` names where no delivering issue has landed', async () => {
    await environments({}, 'stg');
    const unlanded = await createTestIssue(world.projectId, world.ownerId, 524, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    await delivering(unlanded.id);
    const run = await judgeAtRequirement();

    const res = await secrets(world.boxToken, run.boxRunId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'stg', secrets: [{ ref: REF, value: VALUE }] });
    expect((await reads())[0]).toMatchObject({ basis: 'judgedOn', issue_id: null });
  });

  it('reads production where no delivering issue landed and no judgedOn is named', async () => {
    await environments({
      live: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        testing: 'stg',
        url: 'https://adminhub.example.test',
      },
    });
    const run = await judgeAtRequirement();

    const res = await secrets(world.boxToken, run.boxRunId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'live', secrets: [{ ref: REF, value: VALUE }] });
    expect((await reads())[0]).toMatchObject({ basis: 'production', environment: 'live' });
  });

  it('refuses by name where no environment can be named, saying what to declare, never that the run names no issue', async () => {
    const unlanded = await createTestIssue(world.projectId, world.ownerId, 525, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    await delivering(unlanded.id);
    const run = await judgeAtRequirement();

    const res = await secrets(world.boxToken, run.boxRunId);

    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NO_JUDGED_ENVIRONMENT');
    const text = said(res.body);
    expect(text).toContain('none of the 1 issues delivering REQ-35 has landed');
    expect(text).toContain('the project names no `delivery.judgedOn`');
    expect(text).toContain('it declares no production environment');
    expect(text).toContain(
      'Declare the judge over an issue delivering REQ-35 once its work has landed (`forge-runner run declare <ISS-n> --role qa`)',
    );
    expect(text).not.toMatch(/declared over no issue|works no issue|names no issue/);
    expect(await reads()).toHaveLength(0);
  });
});
