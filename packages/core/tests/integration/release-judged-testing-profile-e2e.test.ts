/**
 * ISS-1407 (sid-desk FB-814, FB-815): a project landing every issue on staging and promoting to
 * production by release handed every judge the staging profile, even a run judging a release whose
 * production verdicts were owed, since only the merge-mark target named the environment. A judge of
 * an issue a shipped release carried now reads production's profile; landed work no release has
 * carried reads its merge target's environment as before; and TESTING_PROFILE_NOT_NAMED says which
 * environment the run judges and what named it. Fake secret values only. Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/judged-environment.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  codeOf,
  declaredRun,
  landedIssue,
  ok,
  REF,
  seedDeclaredRunWorld,
  VALUE,
  world,
} from '../helpers/declared-run-secrets-world.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const PROD_VALUE = 'ops-reader@sid-desk.test:Pl4nted-Fake-Only';
const PROD_REF = 'secret://test/prod-ops';

/** sid-desk's shape: `staging` deploys `release/stg` naming `stg`, `production` deploys `main` naming `prod`. */
async function sidDesk(): Promise<void> {
  const token = await userToken(world.ownerId);
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/secrets/test/prod-ops`, {
      value: PROD_VALUE,
    }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/testing-profiles/prod`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'prod',
        actors: { ops: { role: 'project-admin', credential: PROD_REF } },
        services: {},
        limits: [],
      },
    }),
  );
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    promotions: [{ from: 'release/stg', to: 'main', via: 'merge' }],
    environments: {
      staging: {
        tier: 'staging',
        deploysFrom: 'release/stg',
        deployment: { mode: 'external' },
        testing: 'stg',
        url: 'https://stg.sid-desk.example.test',
      },
      production: {
        tier: 'production',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        testing: 'prod',
        url: 'https://sid-desk.example.test',
      },
    } as never,
  });
}

/** A release that shipped `issueId` to production as `version`. */
async function shipped(issueId: string, version: string): Promise<void> {
  const at = new Date(Date.now() - 60_000).toISOString();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${world.projectId}, 'system', 'completed', ${at}::timestamptz, ${version},
            ${at}::timestamptz, ${JSON.stringify({ issueIds: [issueId], source: 'release-batch' })}::jsonb)`);
}

const read = (id: string, profile: string, query: string) =>
  api(world.boxToken, 'GET', `/api/jobs/${id}/testing-profiles/${profile}/secrets?${query}`);

beforeEach(async () => {
  await seedDeclaredRunWorld();
  await sidDesk();
});

describe('a judge of a release reads the profile of the environment it deployed to (ISS-1407)', () => {
  it('an issue marked on staging and shipped to production is handed prod, audited as the release', async () => {
    const issueId = await landedIssue(world.projectId, 30);
    await shipped(issueId, '0.30.0');
    const run = await declaredRun(world.projectId, 30);
    const res = await read(run.boxRunId, 'prod', 'actor=ops');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      environment: 'production',
      profileId: 'prod',
      secrets: [{ ref: PROD_REF, value: PROD_VALUE }],
    });
    const audit = await rows<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'testing_secrets.resolved'`);
    expect(audit[0]?.payload).toMatchObject({ environment: 'production', basis: 'release' });
    expect(JSON.stringify(audit)).not.toContain(PROD_VALUE);
  });

  it('the shipped issue still reads staging where staging is the profile asked for', async () => {
    const issueId = await landedIssue(world.projectId, 31);
    await shipped(issueId, '0.30.0');
    const run = await declaredRun(world.projectId, 31);
    const res = await read(run.boxRunId, 'stg', 'actor=admin');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      environment: 'staging',
      secrets: [{ ref: REF, value: VALUE }],
    });
  });

  it('landed work no release has carried reads its merge target, and prod is refused naming it', async () => {
    await landedIssue(world.projectId, 32);
    const run = await declaredRun(world.projectId, 32);
    const stg = await read(run.boxRunId, 'stg', 'actor=admin');
    expect(stg.status, JSON.stringify(stg.body)).toBe(200);
    expect(stg.body).toMatchObject({ environment: 'staging' });
    const prod = await read(run.boxRunId, 'prod', 'actor=ops');
    expect(prod.status, JSON.stringify(prod.body)).toBe(422);
    expect(codeOf(prod.body)).toBe('TESTING_PROFILE_NOT_NAMED');
    const said = JSON.stringify(prod.body);
    expect(said).toContain('environment `staging`');
    expect(said).toContain('merge-mark target `release/stg`');
    expect(said).not.toContain(PROD_VALUE);
  });

  it('a refusal on a shipped issue names production and the release that named it', async () => {
    const issueId = await landedIssue(world.projectId, 33);
    await shipped(issueId, '0.31.0');
    const run = await declaredRun(world.projectId, 33);
    const res = await read(run.boxRunId, 'qa', 'actor=ops');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_PROFILE_NOT_NAMED');
    expect(JSON.stringify(res.body)).toContain('environment `production`');
    expect(JSON.stringify(res.body)).toContain('release 0.31.0');
  });

  it('an unmarked issue falls back to production, and a refusal there names the fallback', async () => {
    await createTestIssue(world.projectId, world.ownerId, 34, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    const run = await declaredRun(world.projectId, 34, { openedAt: 'in_progress' });
    const prod = await read(run.boxRunId, 'prod', 'actor=ops');
    expect(prod.status, JSON.stringify(prod.body)).toBe(200);
    expect(prod.body).toMatchObject({ environment: 'production' });
    const stg = await read(run.boxRunId, 'stg', 'actor=admin');
    expect(stg.status, JSON.stringify(stg.body)).toBe(422);
    expect(codeOf(stg.body)).toBe('TESTING_PROFILE_NOT_NAMED');
    expect(JSON.stringify(stg.body)).toContain('the fallback, its production environment');
  });
});
