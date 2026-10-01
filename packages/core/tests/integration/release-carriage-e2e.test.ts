/**
 * ISS-1368 — a waiting issue whose verdicts were judged at a commit the project now serves a
 * descendant of, or whose runner-only change the runners run, is released by the sweep; one whose
 * runtime truly lacks it stays held naming that runtime. Real Postgres, a Coolify double answering
 * what Forge deployed, and a GitHub double answering compares, because what is asserted is what a
 * sweep tick leaves on the rows.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeCoolify,
  recordForgeDeployment,
  type CoolifyTarget as Target,
} from '../helpers/coolify-deployments.js';
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

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

/** What the GitHub double answers: `compare` keyed `base...head`, `commits` keyed by sha. */
interface Repo {
  compare: Map<string, { status: string; files: string[] }>;
  parents: Map<string, string>;
  asked: string[];
}

let server: Server;
let apiBase: string;
const repo: Repo = { compare: new Map(), parents: new Map(), asked: [] };

async function startGitHub(): Promise<string> {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    repo.asked.push(url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.includes('/access_tokens')) {
      return send(201, { token: 'ghs_installation_token', expires_at: '2099-01-01T00:00:00Z' });
    }
    const compared = /\/compare\/([^/?]+)$/.exec(url.split('?')[0] ?? '');
    if (compared) {
      const answer = repo.compare.get(decodeURIComponent(compared[1] ?? ''));
      if (!answer) return send(404, { message: 'No common ancestor between these commits.' });
      return send(200, {
        status: answer.status,
        files: answer.files.map((filename) => ({ filename })),
      });
    }
    const commit = /\/commits\/([0-9a-f]+)$/.exec(url);
    if (commit) {
      const parent = repo.parents.get(commit[1] ?? '');
      if (!parent) return send(404, { message: 'No commit found' });
      return send(200, { sha: commit[1], parents: [{ sha: parent }] });
    }
    return send(404, { message: `the double serves no ${url}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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
  apiBase = await startGitHub();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (harness) await harness.cleanup();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

const APP: Target = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

async function bindGitHub(): Promise<void> {
  const store = await import('../../src/integrations/store.js');
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'github',
    displayName: 'GitHub App test',
    secrets: { appId: randomUUID(), privateKey: APP_PRIVATE_KEY, webhookSecret: 'whs' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'github',
    role: 'service',
    label: '',
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: 1, apiBaseUrl: apiBase },
    integrationSecret: 'whs',
  });
}

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
  repo.compare.clear();
  repo.parents.clear();
  repo.asked.length = 0;
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (
    await createTestProject(harness.db, owner.id, {
      agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
    })
  ).id;
  await fx.seedReleaseRunner();
  await bindGitHub();
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
    expect(reason).toContain('returned HTTP 404: No common ancestor between these commits.');
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

/** A landing at JUDGED that changed only a core file. */
function coreOnlyLanding(): void {
  repo.parents.set(JUDGED, PARENT);
  repo.compare.set(`${PARENT}...${JUDGED}`, { status: 'ahead', files: ['packages/core/x.ts'] });
}

describe('a hold names what the issue owes and what clears it', () => {
  it('names only the deployment for a core-only change, though a declared runtime reads nothing', async () => {
    await declareRunner();
    coreOnlyLanding();
    await serveCore(BEHIND);
    repo.compare.set(`${JUDGED}...${BEHIND}`, { status: 'behind', files: [] });
    repo.compare.set(`${BEHIND}...${JUDGED}`, { status: 'ahead', files: ['packages/core/x.ts'] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain(`judged at ${JUDGED}, which is not a commit this project is serving`);
    expect(reason).toContain(`\`${BEHIND}\` at`);
    expect(reason).not.toContain('`runner` runtime');
    expect(reason).not.toContain('reports no build commit');
  }, 30_000);

  it('names only the runner runtime for a runner-only change, never the deployment', async () => {
    await declareRunner();
    runnerOnlyLanding();
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, { status: 'ahead', files: [] });
    await runnersRun(LACKING);
    repo.compare.set(`${JUDGED}...${LACKING}`, { status: 'behind', files: [] });
    repo.compare.set(`${LACKING}...${JUDGED}`, { status: 'ahead', files: [RUNNER_FILE] });
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const hold = await fx.holdOf(id);
    const reason = String(hold?.reason);
    expect(reason).toContain('the `runner` runtime, under `packages/runner`');
    expect(reason).not.toContain('the deployment:');
    expect(reason).not.toContain(DESCENDANT);
    expect(String(hold?.waitingFor)).not.toContain('the running deployment');
  }, 30_000);

  it('gives the route where no runner of the project is online', async () => {
    await declareRunner();
    runnerOnlyLanding();
    await serveCore(DESCENDANT);
    repo.compare.set(`${JUDGED}...${DESCENDANT}`, { status: 'ahead', files: [] });
    await harness.db.execute(sql`
      UPDATE devices d SET status = 'offline'
        FROM runners r WHERE r.device_id = d.id AND r.project_id = ${projectId}
    `);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const hold = await fx.holdOf(id);
    const reason = String(hold?.reason);
    expect(reason).toContain('no runner device of this project is online');
    expect(reason).toContain('bring one of this project’s runners online on a build that carries');
    expect(reason).toContain('the next sweep weighs it again with no new verdict');
    expect(String(hold?.waitingFor)).toContain('runners');
  }, 30_000);

  it('names the stored declaration and its path, not the verdicts, where it no longer parses', async () => {
    await harness.db.execute(sql`
      UPDATE projects
         SET agent_config = jsonb_set(agent_config, '{pipelineConfig,releaseRuntimes}', '[{"name":"runner","paths":["packages/runner/**"],"servedBy":"project-runners"}]'::jsonb)
       WHERE id = ${projectId}
    `);
    await serveCore(DESCENDANT);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    const reason = String(hold?.reason);
    expect(reason).not.toMatch(/^The verdicts/);
    expect(reason).toContain('releaseRuntimes.0.paths.0');
    expect(String(hold?.waitingFor)).toContain('releaseRuntimes');
  }, 30_000);

  it('refuses a stored path with a leading space by name when the release reads it', async () => {
    await harness.db.execute(sql`
      UPDATE projects
         SET agent_config = jsonb_set(agent_config, '{pipelineConfig,releaseRuntimes}', '[{"name":"runner","paths":[" packages/runner"],"servedBy":"project-runners"}]'::jsonb)
       WHERE id = ${projectId}
    `);
    await serveCore(DESCENDANT);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const hold = await fx.holdOf(id);
    expect(hold?.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    expect(String(hold?.reason)).toContain('" packages/runner"');
  }, 30_000);

  it('tells a project whose repository is not on GitHub what its host allows, not to bind GitHub', async () => {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET active = false WHERE project_id = ${projectId} AND provider = 'github'
    `);
    await harness.db.execute(sql`
      UPDATE projects SET repo_url = 'git@gitlab.com:sidcorp/sid-desk.git' WHERE id = ${projectId}
    `);
    await serveCore(BEHIND);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    const reason = String((await fx.holdOf(id))?.reason);
    expect(reason).toContain('gitlab.com');
    expect(reason).not.toContain('bind a repository on its Integrations page');
    expect(reason).toContain(`\`${BEHIND}\``);
  }, 30_000);

  it('keeps the GitHub binding advice for a project whose repository is on GitHub', async () => {
    await harness.db.execute(sql`
      UPDATE integration_bindings SET active = false WHERE project_id = ${projectId} AND provider = 'github'
    `);
    await harness.db.execute(sql`
      UPDATE projects SET repo_url = 'git@github.com:SidCorp-co/forge.git' WHERE id = ${projectId}
    `);
    await serveCore(BEHIND);
    const id = await fx.judgedRow(JUDGED, '2026-10-01T09:00:00Z');

    await sweep();

    expect(String((await fx.holdOf(id))?.reason)).toContain('Integrations page');
  }, 30_000);
});
