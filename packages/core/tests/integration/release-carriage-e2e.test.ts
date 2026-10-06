/**
 * ISS-1368 — a waiting issue whose verdicts were judged at a commit the project now serves a
 * descendant of, or whose runner-only change the runners run, is released by the sweep; one whose
 * runtime truly lacks it stays held naming that runtime. Real Postgres, a Coolify double answering
 * what Forge deployed, and a GitHub double answering compares, because what is asserted is what a
 * sweep tick leaves on the rows.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCoolify,
  recordForgeDeployment,
  type CoolifyTarget as Target,
} from '../helpers/coolify-deployments.js';
import { type GitHubDouble, startGitHubDouble } from '../helpers/github-double.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const JUDGED = '655cc09cebfc9eb07840dfed6bccd04aaf7f1728';
const PARENT = '1111111111111111111111111111111111111111';
const DESCENDANT = '420d3a80aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BEHIND = '7252b45c5bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RUNNER_BUILD = '07f2009aaccccccccccccccccccccccccccccccc';
const LACKING = '82ce8f4ddddddddddddddddddddddddddddddddd';
const RUNNER_FILE = 'packages/runner/crates/forge-runner/src/cmd/top/render.rs';

/** The start branch's head; the promotion range up to it carries nothing off the roster. */
const MAIN_HEAD = '9a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

let repo: GitHubDouble;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  repo = await startGitHubDouble();
}, 60_000);

afterAll(async () => {
  if (repo) await repo.close();
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

/** Core is served at `commit`, as Forge deployed it through the live Coolify binding. */
async function serveCore(commit: string): Promise<void> {
  await fx.declareProduction({ verify: null, baseUrl: coolify.url(), targets: [APP] });
  const rows = (await harness.db.execute(sql`
    SELECT id FROM integration_bindings WHERE project_id = ${projectId} AND provider = 'coolify'
  `)) as unknown as Array<{ id: string }>;
  coolify.deployments.set('dep-core', commit);
  await recordForgeDeployment(
    harness,
    String(rows[0]?.id),
    APP,
    'dep-core',
    '2026-10-01T10:00:00Z',
  );
}

async function declareRunner(): Promise<void> {
  const runtimes = [{ name: 'runner', paths: ['packages/runner'], servedBy: 'project-runners' }];
  await harness.db.execute(sql`
    UPDATE projects
       SET agent_config = jsonb_set(agent_config, '{pipelineConfig,releaseRuntimes}', ${JSON.stringify(runtimes)}::jsonb)
     WHERE id = ${projectId}
  `);
}

async function runnersRun(commit: string): Promise<void> {
  await harness.db.execute(sql`
    UPDATE devices d SET agent_commit = ${commit}
      FROM runners r WHERE r.device_id = d.id AND r.project_id = ${projectId}
  `);
}

/** A landing at JUDGED that changed only a runner file. */
function runnerOnlyLanding(): void {
  repo.parents.set(JUDGED, PARENT);
  repo.compare.set(`${PARENT}...${JUDGED}`, { status: 'ahead', files: [RUNNER_FILE] });
}

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  resetSweepCursorsForTest();
  forgetCarriage();
  return sweepAutomaticReleases();
}

async function readinessHeld(): Promise<string[]> {
  const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  forgetCarriage();
  const readiness = await loadReleaseReadiness(projectId);
  const held = readiness?.blockers.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');
  const named = (held?.details as { held?: Array<{ issueId: string }> } | undefined)?.held ?? [];
  return named.map((h) => h.issueId);
}

beforeEach(async () => {
  await truncateAll(harness.db);
  coolify.deployments.clear();
  repo.reset();
  repo.heads.set('main', MAIN_HEAD);
  repo.compare.set(`production...${MAIN_HEAD}`, { status: 'ahead', commits: [] });
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  await fx.seedReleaseRunner();
  await repo.bind(projectId, ownerId);
});

describe('a served descendant carries the judged commit', () => {
  it('releases a row judged at an ancestor of what core serves, on one tick, and clears its hold', async () => {
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, {
      status: 'ahead',
      files: ['packages/core/x.ts'],
    });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');
    const comments = await fx.commentCount(id);

    expect(await readinessHeld()).toEqual([]);
    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect((await fx.stored(id)).status).toBe('releasing');
    expect(await fx.holdOf(id)).toBeNull();
    // No verdict was written to earn it: only what the release itself says may follow.
    const verdicts = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${id} AND body LIKE '%forge-record: verdict%'
    `)) as unknown as Array<{ n: number }>;
    expect(verdicts[0]?.n).toBe(1);
    expect(await fx.commentCount(id)).toBeGreaterThanOrEqual(comments);
  }, 30_000);

  it('holds a row whose served commit neither is nor descends from it, naming the files', async () => {
    await serveCore(BEHIND);
    repo.compare.set(`${JUDGED}...${BEHIND}`, { status: 'behind', files: [] });
    repo.compare.set(`${BEHIND}...${JUDGED}`, { status: 'ahead', files: ['packages/core/x.ts'] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain(`judged at ${JUDGED}, which is not a commit this project is serving`);
    expect(reason).toContain(
      'what it serves does not descend from it and differs from it in 1 file',
    );
    expect(reason).toContain('`packages/core/x.ts`');
    expect(await readinessHeld()).toEqual([id]);
  }, 30_000);

  it('holds by equality alone, naming why, where the repository cannot compare the pair', async () => {
    await serveCore(BEHIND);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('whether what it serves carries it could not be read');
    expect(reason).toContain('returned HTTP 404');
  }, 30_000);
});

describe('a runner-only change is weighed against the runner it runs in', () => {
  it('releases it where core is behind it only in runner files and the runners run a tree-equal build', async () => {
    await declareRunner();
    runnerOnlyLanding();
    await serveCore(BEHIND);
    repo.compare.set(`${JUDGED}...${BEHIND}`, { status: 'behind', files: [] });
    repo.compare.set(`${BEHIND}...${JUDGED}`, { status: 'ahead', files: [RUNNER_FILE] });
    await runnersRun(RUNNER_BUILD);
    repo.compare.set(`${JUDGED}...${RUNNER_BUILD}`, {
      status: 'diverged',
      files: ['CHANGELOG.md'],
    });
    repo.compare.set(`${RUNNER_BUILD}...${JUDGED}`, {
      status: 'diverged',
      files: ['CHANGELOG.md'],
    });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    expect(await readinessHeld()).toEqual([]);
    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect(await fx.holdOf(id)).toBeNull();
  }, 30_000);

  it('holds it where the runners run a build that lacks it, naming the runner runtime and its build', async () => {
    await declareRunner();
    runnerOnlyLanding();
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, { status: 'ahead', files: [] });
    await runnersRun(LACKING);
    repo.compare.set(`${JUDGED}...${LACKING}`, { status: 'behind', files: [] });
    repo.compare.set(`${LACKING}...${JUDGED}`, { status: 'ahead', files: [RUNNER_FILE] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain(`judged at ${JUDGED}, which the \`runner\` runtime is not running`);
    expect(reason).toContain(`\`${LACKING}\` at runner device`);
    expect(reason).toContain(`\`${RUNNER_FILE}\``);
    expect(await readinessHeld()).toEqual([id]);
  }, 30_000);

  it('holds it where no runner device reports a build, naming the runtime', async () => {
    await declareRunner();
    runnerOnlyLanding();
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, { status: 'ahead', files: [] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('nothing reports what the `runner` runtime is running');
    expect(reason).toContain('reports no build commit');
  }, 30_000);

  it('weighs a landing whose paths cannot be read against every runtime, and says so', async () => {
    await declareRunner();
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, { status: 'ahead', files: [] });
    await runnersRun(LACKING);
    repo.compare.set(`${JUDGED}...${LACKING}`, { status: 'behind', files: [] });
    repo.compare.set(`${LACKING}...${JUDGED}`, { status: 'ahead', files: [RUNNER_FILE] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('the `runner` runtime is not running');
    expect(reason).toContain("what this issue's landing changed could not be read");
  }, 30_000);

  it('holds every waiting row naming the declaration where the stored runtimes no longer parse', async () => {
    await harness.db.execute(sql`
      UPDATE projects
         SET agent_config = jsonb_set(agent_config, '{pipelineConfig,releaseRuntimes}', '[{"name":"runner","paths":["/abs"],"servedBy":"project-runners"}]'::jsonb)
       WHERE id = ${projectId}
    `);
    await serveCore(DESCENDANT);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    expect(String(hold?.reason)).toContain('releaseRuntimes is not a valid declaration');

    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');
    const readiness = await loadReleaseReadiness(projectId);
    const unevaluated = readiness?.blockers.find((b) => b.code === 'RELEASE_CHECK_UNEVALUATED');
    expect(unevaluated?.details).toMatchObject({ check: 'criteria' });
    expect(JSON.stringify(unevaluated?.details)).toContain(
      'releaseRuntimes is not a valid declaration',
    );
  }, 30_000);
});
