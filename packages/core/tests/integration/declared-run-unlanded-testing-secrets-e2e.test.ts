/**
 * ISS-1379: a run declared over a docs or screenshot issue, whose work lands nowhere, was refused
 * TESTING_SECRETS_NOT_LANDED and could sign in only by marking a merge that never happened. It now
 * reads the environment the project's work is judged on (`delivery.judgedOn`, else production), as
 * a run declared at a requirement does, and no merge mark is written; a marked issue still reads
 * its merge target's environment, and a mark with no target keeps its refusal. ISS-1407 c4: such a
 * run (an investigation) may name the environment it reads, and is handed only the profile that
 * environment names, the read recorded with the environment and what named it. Fake secret values
 * only. Against real Postgres.
 *
 * @direct-test-of packages/core/src/project-config/judged-environment.ts
 * @direct-test-of packages/core/src/project-config/testing-secrets.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the testing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import {
  codeOf,
  declaredRun,
  landedIssue,
  REF,
  secrets,
  seedDeclaredRunWorld,
  VALUE,
  world,
} from '../helpers/declared-run-secrets-world.js';
import { createTestIssue, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

beforeEach(seedDeclaredRunWorld);

describe('a run over an issue with nothing to land reads the environment the project is judged on', () => {
  /** `stg` deploys `release/stg`; `live` deploys `main`; both name profile `stg`, and `judgedOn` picks. */
  async function judgedOn(judged: string | null) {
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
        live: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { mode: 'external' },
          testing: 'stg',
          url: 'https://adminhub.example.test',
        },
      } as never,
      ...(judged ? { extra: { delivery: { judgedOn: judged } } as never } : {}),
    });
  }

  async function unmarked(seq: number): Promise<string> {
    const { id } = await createTestIssue(world.projectId, world.ownerId, seq, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    return id;
  }

  it('reads the profile of the environment `delivery.judgedOn` names, and marks nothing', async () => {
    await judgedOn('stg');
    const issueId = await unmarked(80);
    const run = await declaredRun(world.projectId, 80, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      run: { session: run.session, id: run.runId },
      environment: 'stg',
      profileId: 'stg',
      secrets: [{ ref: REF, value: VALUE }],
    });
    const [issue] = await rows<{ merged_at: Date | null; merged_target: string | null }>(
      sql`SELECT merged_at, merged_target FROM issues WHERE id = ${issueId}`,
    );
    expect(issue).toEqual({ merged_at: null, merged_target: null });
    const audit = await rows<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'testing_secrets.resolved'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({ environment: 'stg', profile: 'stg' });
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it('reads production where the project names no `delivery.judgedOn`', async () => {
    await judgedOn(null);
    await unmarked(81);
    const run = await declaredRun(world.projectId, 81, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'live', secrets: [{ ref: REF, value: VALUE }] });
  });

  it('still reads the environment its merge target names for a marked issue', async () => {
    await judgedOn('live');
    await landedIssue(world.projectId, 82);
    const run = await declaredRun(world.projectId, 82);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'stg' });
  });

  it('keeps the clear-then-mark refusal for an issue marked with no target', async () => {
    await judgedOn('stg');
    await createTestIssue(world.projectId, world.ownerId, 83, {
      status: 'awaiting_release',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const run = await declaredRun(world.projectId, 83);
    const res = await secrets(world.boxToken, run.boxRunId);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NOT_LANDED');
    expect(JSON.stringify(res.body)).toContain('Clear the standing mark (DELETE /api/issues/');
  });
});

describe('a run over an issue with nothing landed names the environment it reads (ISS-1407 c4)', () => {
  /** `stg` deploys `release/stg` naming `stg`; `live` deploys `main` naming `stg`; `preview` names none. */
  async function environments() {
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
        live: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { mode: 'external' },
          testing: 'stg',
          url: 'https://adminhub.example.test',
        },
        preview: {
          tier: 'preview',
          deploysFrom: 'preview',
          deployment: { mode: 'external' },
          url: 'https://preview.adminhub.example.test',
        },
      } as never,
    });
  }

  const investigation = async (seq: number) =>
    (
      await createTestIssue(world.projectId, world.ownerId, seq, {
        status: 'in_progress',
        createdAt: new Date(),
      })
    ).id;

  it('reads the environment it names, not the fallback, and the read records it named it', async () => {
    await environments();
    const issueId = await investigation(90);
    const run = await declaredRun(world.projectId, 90, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId, 'actor=admin&environment=stg');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ environment: 'stg', secrets: [{ ref: REF, value: VALUE }] });
    const audit = await rows<{ payload: Record<string, unknown> }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'testing_secrets.resolved'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      environment: 'stg',
      basis: 'named',
      runId: run.runId,
      profile: 'stg',
    });
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  it('refuses an environment the document does not declare, by name, reading nothing', async () => {
    await environments();
    const issueId = await investigation(91);
    const run = await declaredRun(world.projectId, 91, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId, 'actor=admin&environment=nowhere');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_ENVIRONMENT_UNDECLARED');
    expect(JSON.stringify(res.body)).toContain('`nowhere`');
    const audit = await rows(sql`
      SELECT 1 FROM activity_log WHERE issue_id = ${issueId} AND action = 'testing_secrets.resolved'`);
    expect(audit).toHaveLength(0);
  });

  it('refuses an environment naming no testing profile, by name', async () => {
    await environments();
    await investigation(92);
    const run = await declaredRun(world.projectId, 92, { openedAt: 'in_progress' });
    const res = await secrets(world.boxToken, run.boxRunId, 'actor=admin&environment=preview');
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(codeOf(res.body)).toBe('TESTING_SECRETS_NO_TESTING_PROFILE');
    expect(JSON.stringify(res.body)).toContain('environments.preview.testing');
  });

  it('refuses a named environment for an issue whose work landed elsewhere', async () => {
    await environments();
    await landedIssue(world.projectId, 93);
    const run = await declaredRun(world.projectId, 93);
    const res = await secrets(world.boxToken, run.boxRunId, 'actor=admin&environment=live');
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res.body)).toBe('TESTING_ENVIRONMENT_NOT_JUDGED');
    expect(JSON.stringify(res.body)).toContain('merge-mark target `release/stg`');
    const same = await secrets(world.boxToken, run.boxRunId, 'actor=admin&environment=stg');
    expect(same.status, JSON.stringify(same.body)).toBe(200);
  });
});
