/**
 * ISS-1217 reopen 4 — portal-lighthuman's shape against real rows: branches fast-forwarded onto
 * `staging`, their commits naming no key, one of them the head ISS-71's run recorded. The
 * repository is real git read through the project's deploy key, with only the ssh hop replaced;
 * the project has no GitHub binding, so the real client refuses it. The projects, key, issues and
 * their `session_context` are Postgres.
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

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const GITLAB = 'git@gitlab.com:lighthuman/portal_lh.git';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nportal deploy key\n';
let remote = '';

vi.mock('../../src/git/remote-divergence.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/git/remote-divergence.js')>();
  return {
    ...real,
    readRemoteDivergence: async (
      _source: { repoUrl: string; privateKey: string },
      refs: { baseRef: string; liveRef: string },
    ) => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-recorded-head-e2e-'));
      try {
        const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
        return await real.fetchDivergence(`file://${remote}`, env, refs, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
});

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let encryptSecret: typeof import('../../src/integrations/vault.js').encryptSecret;
let fixtureRoot = '';
let cut = '';
let declared = '';
let pint = '';
let tip = '';

/**
 * On `staging` above `master`: a commit declaring ISS-60, a keyless commit no issue records, and a
 * keyless tip ISS-71's run recorded as its head — each a direct commit, no merge above any.
 */
function buildPortalRepository(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'forge-portal-'));
  remote = join(fixtureRoot, 'portal');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: remote, env }).toString().trim();
  execFileSync('git', ['init', '--quiet', '--initial-branch=master', remote], { env });
  git('config', 'uploadpack.allowFilter', 'true');
  git('commit', '--quiet', '--allow-empty', '-m', 'docs(changelog): ISS-59 released');
  const tree = git('rev-parse', 'HEAD^{tree}');
  cut = git('rev-parse', 'HEAD');
  declared = git('commit-tree', tree, '-p', cut, '-m', 'fix(client): orphans (ISS-60 AC8)');
  pint = git('commit-tree', tree, '-p', declared, '-m', 'style(client): satisfy pint');
  tip = git('commit-tree', tree, '-p', pint, '-m', 'fix(deploy): report the running build commit');
  git('update-ref', 'refs/heads/staging', tip);
}

async function portalProject(userId: string) {
  const p = await createTestProject(harness.db, userId);
  await createTestProjectMember(harness.db, { userId, projectId: p.id, role: 'admin' });
  await harness.db.execute(sql`
    UPDATE projects SET base_branch = 'staging', release_model = 'promote', live_branch = 'master',
      release_strategy = 'merge-branch', repo_url = ${GITLAB}
    WHERE id = ${p.id}
  `);
  const keyId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO workspace_ssh_keys (id, org_id, name, source, public_key, private_key_enc)
    VALUES (${keyId}, ${p.orgId}, 'Forge x Gitlab', 'forge_generated',
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 forge-x-gitlab', ${encryptSecret(DEPLOY_KEY)})
  `);
  await harness.db.execute(sql`
    INSERT INTO project_git_credentials (project_id, ssh_key_id) VALUES (${p.id}, ${keyId})
  `);
  return p;
}

async function closedIssue(
  projectId: string,
  userId: string,
  seq: number,
  worklog?: { head: string; base: string; branch: string },
) {
  const id = randomUUID();
  const session = worklog ? JSON.stringify({ worklog }) : null;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, session_context)
    VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq} on portal`}, 'closed', ${userId},
            now() - interval '1 hour', ${session}::jsonb)
  `);
  return id;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

type Reach = {
  state: string;
  evidence?: Array<{ sha: string; via: string }>;
  unowned?: Array<{ sha: string; subject: string }>;
} | null;

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
  ({ encryptSecret } = await import('../../src/integrations/vault.js'));
  buildPortalRepository();

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
});

describe('a promote project whose commits name no key (ISS-1217 reopen 4)', () => {
  it("places a row on its run's recorded head, and says which waiting commits belong to no issue", async () => {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const token = await signUserToken(user.id);
    const portal = await portalProject(user.id);
    const reports = await closedIssue(portal.id, user.id, 71, {
      head: tip,
      base: cut,
      branch: 'ISS-71-report-running-commit',
    });
    const shipped = await closedIssue(portal.id, user.id, 55);
    const idle = await closedIssue(portal.id, user.id, 80, {
      head: pint,
      base: pint,
      branch: 'ISS-80-idle',
    });
    const onDeclared = await closedIssue(portal.id, user.id, 81, {
      head: declared,
      base: cut,
      branch: 'ISS-81-cut-late',
    });

    const reach = (await get<{ liveReach: Reach }>(`/api/issues/${reports}`, token)).liveReach;
    expect(reach?.state).toBe('not_on_live');
    expect(reach?.evidence).toEqual([expect.objectContaining({ sha: tip, via: 'recorded_head' })]);
    const byKey = await get<{ liveReach: Reach }>(
      `/api/projects/${portal.id}/issues/by-display/ISS-71`,
      token,
    );
    expect(byKey.liveReach).toEqual(reach);

    for (const id of [shipped, idle, onDeclared]) {
      expect((await get<{ liveReach: Reach }>(`/api/issues/${id}`, token)).liveReach).toMatchObject(
        {
          state: 'none_waiting',
          unowned: [{ sha: pint, subject: 'style(client): satisfy pint' }],
        },
      );
    }

    const pulse = await get<PulseResponse>('/api/me/pulse', token);
    expect(pulse.work.notOnLive.shown.map((i) => i.issueRef)).toEqual(['ISS-71']);
    expect(pulse.work.notOnLive.shown[0]?.evidence).toEqual([
      expect.objectContaining({ sha: tip, via: 'recorded_head' }),
    ]);
    expect(pulse.work.liveUnmeasured.shown).toEqual([
      expect.objectContaining({
        id: portal.id,
        reason:
          '1 commit waiting on staging belongs to no issue, so a closed issue whose work it is reads as nothing waiting',
      }),
    ]);
  });
});
