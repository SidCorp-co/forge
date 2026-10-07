// @gate-input whole-tree — it serves a real repository through a fake ssh on PATH, which the root-walk guard cannot see into.
/**
 * ISS-1398 — on a project hosted on GitLab, with no GitHub binding and a deploy key attached, the
 * automatic release weighs a verdict against what production serves by reading the repository with
 * git as that key, and reads the range a merge-branch release carries the same way. Real Postgres,
 * a Coolify double answering what Forge deployed, and a real bare repository behind a fake `ssh`
 * (`tests/helpers/git-host-fixture.ts`).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITLAB_NO_ACCESS, keyUnknown } from '../../src/git/host-answers.fixture.js';
import {
  fakeCoolify,
  recordForgeDeployment,
  type CoolifyTarget as Target,
} from '../helpers/coolify-deployments.js';
import {
  attachDeployKey,
  GITLAB_URL,
  type GitHost,
  startGitHost,
} from '../helpers/git-host-fixture.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

vi.mock('node:dns', async (importOriginal) =>
  (await import('../helpers/git-host-fixture.js')).publicDns(await importOriginal()),
);

const RUNNER_FILE = 'packages/runner/crates/forge-runner/src/cmd/top/render.rs';

let host: GitHost;
let harness: TestDatabase;
let projectId: string;
let ownerId: string;
const coolify = fakeCoolify();
const at: Record<string, string> = {};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();

  host = startGitHost();
  at.root = host.commit('main', 'chore: root', 'README.md');
  host.branch('production', at.root);
  at.judged = host.commit('main', 'fix(core): the judged change (ISS-1)', 'packages/core/x.ts');
  at.runnerOnly = host.commit('main', 'fix(runner): a runner-only change (ISS-2)', RUNNER_FILE);
  at.descendant = host.commit('main', 'chore: after both', 'packages/core/later.ts');
  at.offRoster = host.commit(
    'main',
    'feat(core): landed and not released (ISS-3)',
    'packages/core/z.ts',
  );
  at.hotfix = host.commit(
    'production',
    'fix(core): straight to production',
    'packages/core/hot.ts',
  );
  host.publish();
}, 60_000);

afterAll(async () => {
  host?.close();
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

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

async function sweep() {
  const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  const { forgetCarriage } = await import('../../src/release-batch/carriage.js');
  resetSweepCursorsForTest();
  forgetCarriage();
  return sweepAutomaticReleases();
}

beforeEach(async () => {
  await truncateAll(harness.db);
  coolify.deployments.clear();
  host.answering(null);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  await fx.seedReleaseRunner();
  await attachDeployKey(harness.db, projectId, GITLAB_URL);
});

describe('ISS-1398 — the release weighs a verdict through the deploy key', () => {
  it('releases a row judged at an ancestor of what production serves, on one tick (criterion 7)', async () => {
    await serveCore(at.descendant as string);
    const id = await fx.judgedRow(at.judged as string, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(1);
    expect((await fx.stored(id)).status).toBe('releasing');
    expect(await fx.holdOf(id)).toBeNull();
  }, 60_000);

  it('holds a row production does not carry, naming every file the two differ in (criterion 8)', async () => {
    await serveCore(at.hotfix as string);
    const id = await fx.judgedRow(at.judged as string, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain(
      'what it serves does not descend from it and differs from it in 2 files',
    );
    expect(reason).toContain('`packages/core/hot.ts`');
    expect(reason).toContain('`packages/core/x.ts`');
  }, 60_000);

  it("reads a runner-only landing's own paths, and holds it on the runner that lacks it (criterion 9)", async () => {
    await declareRunner();
    await serveCore(at.descendant as string);
    await runnersRun(at.hotfix as string);
    const id = await fx.judgedRow(at.runnerOnly as string, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('the `runner` runtime is not running');
    expect(reason).toContain(`\`${RUNNER_FILE}\``);
    expect(reason).not.toContain("what this issue's landing changed could not be read");
  }, 60_000);

  it('holds by equality alone, naming the refused key, where the host refuses it (criteria 12, 16)', async () => {
    host.answering(keyUnknown('gitlab.com'));
    await serveCore(at.descendant as string);
    const id = await fx.judgedRow(at.judged as string, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('whether what it serves carries it could not be read');
    expect(reason).toContain('the git host refused the deploy key attached to this project');
    expect(reason).not.toMatch(/GitHub binding|Integrations/);
  }, 60_000);

  it("holds by equality alone, in GitLab's words, where the key may not read the project (criteria 12, 16)", async () => {
    host.answering(GITLAB_NO_ACCESS);
    await serveCore(at.descendant as string);
    const id = await fx.judgedRow(at.judged as string, '2026-10-01T09:00:00Z');

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('whether what it serves carries it could not be read');
    expect(reason).toContain(GITLAB_NO_ACCESS.said);
    expect(reason).toContain(
      `the git host took the deploy key attached to this project but will not let it read ${GITLAB_URL}`,
    );
    expect(reason).not.toMatch(/remote:\s*(\.|\))/);
    expect(reason).not.toMatch(/GitHub binding|Integrations/);
  }, 60_000);

  // ISS-1398 judge j2 finding 4: the hold advised a verdict, which cannot make the repository
  // readable, and said the key's fix beside the carriage and again beside the paths.
  it('leads the remedy with the key fix, once, where the carriage and the paths both could not be read', async () => {
    host.answering(GITLAB_NO_ACCESS);
    await declareRunner();
    await serveCore(at.descendant as string);
    await runnersRun(at.hotfix as string);
    const id = await fx.judgedRow(at.runnerOnly as string, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    const fix = `give the deploy key attached under the project's Settings → Runners → Git access write access to that repository`;
    expect(reason).toContain('whether what it serves carries it could not be read');
    expect(reason).toContain("what this issue's landing changed could not be read");
    expect(reason.split('Settings → Runners → Git access')).toHaveLength(2);
    expect(reason.split(fix)).toHaveLength(2);
    expect(reason).toContain(
      `A person clears this by making the repository readable: on the git host, ${fix}`,
    );
    expect(reason.indexOf(fix)).toBeLessThan(reason.indexOf('record a verdict'));
    expect(reason).not.toContain('read access');
  }, 60_000);

  it('names the deploy key to attach, never GitHub, where the project has neither (criteria 14, 16)', async () => {
    await harness.db.execute(
      sql`DELETE FROM project_git_credentials WHERE project_id = ${projectId}`,
    );
    await serveCore(at.descendant as string);
    const id = await fx.judgedRow(at.judged as string, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('whether what it serves carries it could not be read');
    expect(reason).toContain(
      `attach a deploy key with write access to ${GITLAB_URL} under the project's Settings → Runners → Git access`,
    );
    expect(reason).not.toMatch(/bind (a|the) repository|Integrations/);
  }, 60_000);
});

describe('ISS-1398 — the range a merge-branch release carries, read through the deploy key', () => {
  it('names an issue whose landing sits between production and the cut (criterion 10)', async () => {
    await fx.declareProduction({ verify: null, baseUrl: coolify.url(), targets: [APP] });
    const other = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
      VALUES (${other}, ${projectId}, 3, 'landed, not released', 'developed', ${ownerId}, now(), ${at.offRoster})
    `);
    const { readCarried } = await import('../../src/release-batch/carried.js');

    const read = await readCarried(projectId, []);

    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.original.cut).toBe(at.offRoster);
    expect(read.original.commits.map((c) => c.sha)).toEqual([
      at.judged,
      at.runnerOnly,
      at.descendant,
      at.offRoster,
    ]);
    expect(read.landed.map((l) => l.issueId)).toContain(other);
  }, 60_000);

  it("leaves the carried range unread in GitLab's words where the key may not read the project (criteria 12, 16)", async () => {
    host.answering(GITLAB_NO_ACCESS);
    await fx.declareProduction({ verify: null, baseUrl: coolify.url(), targets: [APP] });
    const { readCarried } = await import('../../src/release-batch/carried.js');

    const read = await readCarried(projectId, []);

    expect(read.kind).toBe('unread');
    if (read.kind === 'read') return;
    expect(read.why).toContain(GITLAB_NO_ACCESS.said);
    expect(read.why).toContain(`will not let it read ${GITLAB_URL}`);
    expect(read.why).not.toMatch(/remote:\s*(\.|\))/);
  }, 60_000);

  it('warns RELEASE_CARRIED_UNREAD naming the deploy key, never GitHub, where there is no route (criteria 15, 16)', async () => {
    await harness.db.execute(
      sql`DELETE FROM project_git_credentials WHERE project_id = ${projectId}`,
    );
    await serveCore(at.descendant as string);
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');

    const readiness = await loadReleaseReadiness(projectId);

    const warned = readiness?.warnings.find((w) => w.code === 'RELEASE_CARRIED_UNREAD');
    expect(warned?.message).toContain(
      `attach a deploy key with write access to ${GITLAB_URL} under the project's Settings → Runners → Git access`,
    );
    expect(warned?.message).not.toMatch(/bind (a|the) repository|Integrations/);
  }, 60_000);
});
