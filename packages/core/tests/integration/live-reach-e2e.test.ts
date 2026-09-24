/**
 * ISS-1217 — the sid-desk reproduction against real rows: eight closed issues whose commits sit
 * on `staging` and not on `master` at `52c66950`. A GitHub-bound project is stubbed at the
 * repository client; a GitLab-hosted one is read by real git from a local repository, with only
 * the ssh hop replaced. The projects, keys, issues, prefixes and membership are Postgres.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const STAGING = 'f'.repeat(40);
const MASTER = '52c66950'.padEnd(40, '0');
const OBSERVED = '11d071b3'.padEnd(40, '0');
const NOT_LIVE = [419, 423, 429, 432, 434, 435, 440, 442];

const waiting = [
  ...NOT_LIVE.filter((n) => n !== 442).map((n, i) => ({
    sha: `${String(i + 1).padStart(2, '0')}`.padEnd(40, 'a'),
    commit: {
      message:
        i % 2 ? `fix(desk): change (ISS-${n})` : `Merge pull request #${n} from sid/ISS-${n}-slug`,
    },
  })),
  { sha: OBSERVED, commit: { message: 'a squash whose message names no issue' } },
];

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const GITLAB = 'git@gitlab.com:thanhnguyen21/sid-desk.git';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsid-desk deploy key\n';
const gitReads: Array<{ repoUrl: string; privateKey: string }> = [];
let gitRemote = '';

vi.mock('../../src/git/remote-divergence.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/git/remote-divergence.js')>();
  return {
    ...real,
    readRemoteDivergence: async (
      source: { repoUrl: string; privateKey: string },
      refs: { baseRef: string; liveRef: string },
    ) => {
      gitReads.push(source);
      const dir = mkdtempSync(join(tmpdir(), 'forge-live-reach-e2e-'));
      try {
        const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
        return await real.fetchDivergence(`file://${gitRemote}`, env, refs, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
});

const unbound = new Set<string>();
let compares = 0;
let aheadOverride: number | null = null;

vi.mock('../../src/integrations/github/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/github/client.js')>();
  return {
    ...real,
    githubRepoClient: async (projectId: string) => {
      if (unbound.has(projectId)) {
        throw new real.GitHubClientError('no_binding', 'this project has no active GitHub binding');
      }
      return {
        bindingId: 'b',
        appId: '1',
        owner: 'SidCorp-co',
        repo: 'sid-desk',
        fullName: 'SidCorp-co/sid-desk',
        get: async (path: string) => {
          if (path.endsWith('/branches/staging')) return { commit: { sha: STAGING } };
          if (path.endsWith('/branches/master')) return { commit: { sha: MASTER } };
          compares += 1;
          return { ahead_by: aheadOverride ?? waiting.length, commits: waiting };
        },
        publish: async () => {
          throw new Error('a live reading must not publish');
        },
      };
    },
  };
});

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let forgetAllLiveReadings: () => void;
let applyProjectedEvent: typeof import('../../src/integrations/github/projection-events.js').applyProjectedEvent;
let encryptSecret: typeof import('../../src/integrations/vault.js').encryptSecret;
let schema: typeof import('../../src/db/schema.js');
let fixtureRoot = '';
/** The commit on the fixture's staging whose message names no issue: ISS-442's observed merge. */
let gitObserved = '';

/** sid-desk's shape as a real repository: seven commits naming their keys and one naming none. */
function buildSidDeskRepository(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'forge-sid-desk-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: gitRemote, env }).toString().trim();
  gitRemote = join(fixtureRoot, 'sid-desk');
  execFileSync('git', ['init', '--quiet', '--initial-branch=master', gitRemote], { env });
  git('config', 'uploadpack.allowFilter', 'true');
  git(
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'docs(changelog): batch release a74eb6aa (ISS-400)',
  );
  const tree = git('rev-parse', 'HEAD^{tree}');
  let head = git('rev-parse', 'HEAD');
  for (const c of waiting) {
    head = git('commit-tree', tree, '-p', head, '-m', c.commit.message);
  }
  gitObserved = head;
  git('update-ref', 'refs/heads/staging', head);
}

async function gitlabDesk(userId: string, withKey = true) {
  const p = await project(userId, 'promote');
  unbound.add(p.id);
  await harness.db.execute(sql`UPDATE projects SET repo_url = ${GITLAB} WHERE id = ${p.id}`);
  if (!withKey) return p;
  const [key] = await harness.db
    .insert(schema.workspaceSshKeys)
    .values({
      orgId: p.orgId,
      name: 'Forge x Gitlab',
      source: 'forge_generated',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 forge-x-gitlab',
      privateKeyEnc: encryptSecret(DEPLOY_KEY),
    })
    .returning({ id: schema.workspaceSshKeys.id });
  await harness.db
    .insert(schema.projectGitCredentials)
    .values({ projectId: p.id, sshKeyId: key?.id as string });
  return p;
}

async function project(userId: string, release: 'promote' | 'publish') {
  const p = await createTestProject(harness.db, userId);
  await createTestProjectMember(harness.db, { userId, projectId: p.id, role: 'admin' });
  await harness.db.execute(sql`
    UPDATE projects SET base_branch = 'staging',
      release_model = ${release},
      live_branch = ${release === 'promote' ? 'master' : null},
      release_strategy = ${release === 'promote' ? 'merge-branch' : null}
    WHERE id = ${p.id}
  `);
  return p;
}

async function issue(args: {
  projectId: string;
  userId: string;
  seq: number;
  status?: string;
  merged?: boolean;
  sha?: string | undefined;
}) {
  const id = randomUUID();
  const merged = args.merged ?? true;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha)
    VALUES (${id}, ${args.projectId}, ${args.seq}, ${`ISS-${args.seq} on sid-desk`},
            ${args.status ?? 'closed'}, ${args.userId},
            ${merged ? sql`now() - interval '1 hour'` : sql`NULL`}, ${args.sha ?? null})
  `);
  return id;
}

async function signedIn() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { user, token: await signUserToken(user.id) };
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const { issueProjectRoutes, issueRoutes } = await import('../../src/issues/routes.js');
  const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ forgetAllLiveReadings } = await import('../../src/projects/live-reading.js'));
  ({ applyProjectedEvent } = await import('../../src/integrations/github/projection-events.js'));
  ({ encryptSecret } = await import('../../src/integrations/vault.js'));
  schema = await import('../../src/db/schema.js');
  buildSidDeskRepository();

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', issueProjectRoutes);
  app.route('/api/issues', issueRoutes);
  app.route('/api/me', mePulseRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(harness.db);
  forgetAllLiveReadings();
  unbound.clear();
  gitReads.length = 0;
  compares = 0;
  aheadOverride = null;
});

type Reach = {
  state: string;
  evidence?: Array<{ sha: string; via: string }>;
  reason?: string;
} | null;

describe('a closed issue whose work never reached the live branch (ISS-1217)', () => {
  it('places each of the eight rows off master, on both issue reads and in the pulse', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const ids = new Map<number, string>();
    for (const n of NOT_LIVE) {
      ids.set(
        n,
        await issue({
          projectId: desk.id,
          userId: user.id,
          seq: n,
          sha: n === 442 ? OBSERVED : undefined,
        }),
      );
    }
    const shipped = await issue({ projectId: desk.id, userId: user.id, seq: 400 });

    for (const n of NOT_LIVE) {
      const byId = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(n)}`, token);
      expect(byId.liveReach?.state, `ISS-${n}`).toBe('not_on_live');
      const byKey = await get<{ liveReach: Reach }>(
        `/api/projects/${desk.id}/issues/by-display/ISS-${n}`,
        token,
      );
      expect(byKey.liveReach).toEqual(byId.liveReach);
    }
    const observed = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(442)}`, token);
    expect(observed.liveReach?.evidence).toEqual([
      expect.objectContaining({ sha: OBSERVED, via: 'merged_commit' }),
    ]);

    const clear = await get<{ liveReach: Reach }>(`/api/issues/${shipped}`, token);
    expect(clear.liveReach).toMatchObject({
      state: 'none_waiting',
      baseBranch: 'staging',
      liveBranch: 'master',
      baseSha: STAGING,
      liveSha: MASTER,
    });

    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(8);
    expect(pulse.work.notOnLive.shown.map((i) => i.issueRef).sort()).toEqual(
      NOT_LIVE.map((n) => `ISS-${n}`).sort(),
    );
    expect(pulse.work.liveUnmeasured.total).toBe(0);
  });

  it('counts only closed rows in the pulse, and gives nothing on a non-promote project or an unmerged row', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const other = await project(user.id, 'publish');
    await issue({ projectId: desk.id, userId: user.id, seq: 419, status: 'awaiting_release' });
    const open = await issue({
      projectId: desk.id,
      userId: user.id,
      seq: 423,
      status: 'open',
      merged: false,
    });
    const elsewhere = await issue({ projectId: other.id, userId: user.id, seq: 429 });

    expect((await get<{ liveReach: Reach }>(`/api/issues/${open}`, token)).liveReach).toBeNull();
    expect(
      (await get<{ liveReach: Reach }>(`/api/issues/${elsewhere}`, token)).liveReach,
    ).toBeNull();
    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(0);
  });

  it('names a promote project Forge cannot compare, and says why on its rows', async () => {
    const { user, token } = await signedIn();
    const desk = await gitlabDesk(user.id, false);
    const row = await issue({ projectId: desk.id, userId: user.id, seq: 419 });
    const reason =
      "Forge holds no GitHub binding and no deploy key for this project's repository on gitlab.com, so it cannot read the branches — attach a deploy key under the project's Settings → Runners → Git access";

    const reach = (await get<{ liveReach: Reach }>(`/api/issues/${row}`, token)).liveReach;
    expect(reach).toMatchObject({ state: 'unmeasured', reason });
    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.liveUnmeasured.shown).toEqual([
      expect.objectContaining({ id: desk.id, liveBranch: 'master', reason }),
    ]);
    expect(pulse.work.notOnLive.total).toBe(0);
    expect(gitReads).toEqual([]);
  });

  it('compares again after a push delivery for the project, and not after a review delivery', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    const row = await issue({ projectId: desk.id, userId: user.id, seq: 419 });
    const ctx = {
      projectId: desk.id,
      bindingId: randomUUID(),
      config: { owner: 'SidCorp-co', repo: 'sid-desk' },
      secrets: {},
    };

    await get(`/api/issues/${row}`, token);
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(1);
    await applyProjectedEvent(ctx, 'pull_request_review', { action: 'submitted' });
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(1);
    await applyProjectedEvent(ctx, 'push', { ref: 'refs/heads/master' });
    await get(`/api/issues/${row}`, token);
    expect(compares).toBe(2);
  });
});

describe('a reading that cannot place every closed issue (ISS-1217)', () => {
  it('names the project in the pulse when the list was cut short or an issue merged after the reading', async () => {
    const { user, token } = await signedIn();
    const desk = await project(user.id, 'promote');
    await issue({ projectId: desk.id, userId: user.id, seq: 419 });
    aheadOverride = 500;
    let pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(1);
    expect(pulse.work.liveUnmeasured.shown[0]?.reason).toMatch(
      /500 commits ahead of master and the reading listed only 8/,
    );

    aheadOverride = null;
    forgetAllLiveReadings();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${randomUUID()}, ${desk.id}, 900, 'merged later', 'closed', ${user.id}, now() + interval '1 hour')
    `);
    pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.liveUnmeasured.shown[0]?.reason).toMatch(
      /^1 closed issue merged after the reading/,
    );
  });
});

describe('a GitLab-hosted promote project read through its deploy key (ISS-1217 reopen 1)', () => {
  it('places the eight rows off master with no GitHub binding, and counts them in the pulse', async () => {
    const { user, token } = await signedIn();
    const desk = await gitlabDesk(user.id);
    const ids = new Map<number, string>();
    for (const n of NOT_LIVE) {
      ids.set(
        n,
        await issue({
          projectId: desk.id,
          userId: user.id,
          seq: n,
          sha: n === 442 ? gitObserved : undefined,
        }),
      );
    }
    const shipped = await issue({ projectId: desk.id, userId: user.id, seq: 400 });

    for (const n of NOT_LIVE) {
      const byId = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(n)}`, token);
      expect(byId.liveReach?.state, `ISS-${n}`).toBe('not_on_live');
    }
    const observed = await get<{ liveReach: Reach }>(`/api/issues/${ids.get(442)}`, token);
    expect(observed.liveReach?.evidence).toEqual([
      expect.objectContaining({ sha: gitObserved, via: 'merged_commit' }),
    ]);
    expect(
      (await get<{ liveReach: Reach }>(`/api/issues/${shipped}`, token)).liveReach,
    ).toMatchObject({ state: 'none_waiting', baseBranch: 'staging', liveBranch: 'master' });

    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.total).toBe(8);
    expect(pulse.work.liveUnmeasured.total).toBe(0);
    expect(gitReads).toEqual([
      expect.objectContaining({ repoUrl: GITLAB, privateKey: DEPLOY_KEY }),
    ]);
    expect(compares).toBe(0);
  });
});
