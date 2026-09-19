import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  mergeStoredPullRequest: typeof import('../../src/integrations/github/merge.js').mergeStoredPullRequest;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createConnection: typeof import('../../src/integrations/store.js').createConnection;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  createBinding: typeof import('../../src/integrations/store.js').createBinding;
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
};

const OWNER = 'SidCorp-co';
const REPO = 'forge';
const NUMBER = 503;
const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'c0ffee'.padEnd(40, '0');
/** GitHub's own merge time. Deliberately not now: the assertion is that the record is THIS. */
const GITHUB_MERGED_AT = '2026-09-18T11:22:33Z';

// The vault key is module scope because `createConnection` encrypts before any hook runs.
process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: unknown;
}

/** What the double will answer for the pull request, and what it has been asked. */
interface Double {
  base: string;
  seen: Seen[];
  merged: boolean;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  protection: { status: number; body: unknown };
  mergeStatus: number;
  mergeBody: unknown;
}

let server: Server;
let dbl: Double;

function pullBody(): unknown {
  return {
    number: NUMBER,
    state: dbl.merged ? 'closed' : 'open',
    draft: false,
    merged: dbl.merged,
    merge_commit_sha: dbl.merged ? MERGE_COMMIT : null,
    merged_at: dbl.merged ? GITHUB_MERGED_AT : null,
    mergeable: true,
    mergeable_state: 'clean',
    head: { sha: HEAD },
    base: { ref: 'main' },
  };
}

async function startDouble(): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      dbl.seen.push({
        method: req.method ?? '',
        url,
        auth: req.headers.authorization ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.includes('/access_tokens')) {
        return send(201, { token: 'ghs_installation_token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.endsWith('/protection')) return send(dbl.protection.status, dbl.protection.body);
      if (url.includes('/check-runs')) return send(200, { check_runs: dbl.checks });
      if (url.endsWith(`/pulls/${NUMBER}/merge`) && req.method === 'PUT') {
        if (dbl.mergeStatus === 200) dbl.merged = true;
        return send(dbl.mergeStatus, dbl.mergeBody);
      }
      if (url.endsWith(`/pulls/${NUMBER}`)) return send(200, pullBody());
      return send(404, { message: `the double serves no ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

let harness: TestDatabase;
let mods: Mods;
let ownerId: string;
let projectId: string;
let issueId: string;
let pullRequestId: string;

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

  const [mergeMod, store, hooksMod] = await Promise.all([
    import('../../src/integrations/github/merge.js'),
    import('../../src/integrations/store.js'),
    import('../../src/pipeline/hooks.js'),
  ]);
  mods = {
    mergeStoredPullRequest: mergeMod.mergeStoredPullRequest,
    createConnection: store.createConnection,
    createBinding: store.createBinding,
    hooks: hooksMod.hooks,
  };
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const apiBaseUrl = server ? dbl.base : await startDouble();
  dbl = {
    base: apiBaseUrl,
    seen: [],
    merged: false,
    checks: [{ name: 'ci-passed', status: 'completed', conclusion: 'success' }],
    protection: { status: 200, body: { required_status_checks: { contexts: ['ci-passed'] } } },
    mergeStatus: 200,
    mergeBody: { merged: true, sha: MERGE_COMMIT, message: 'Pull Request successfully merged' },
  };

  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;

  const connection = await mods.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'github',
    displayName: 'GitHub App test',
    secrets: { appId: randomUUID(), privateKey: APP_PRIVATE_KEY, webhookSecret: 'whs' },
  });
  const binding = await mods.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'github',
    role: 'service',
    label: '',
    config: { owner: OWNER, repo: REPO, installationId: 159473037, apiBaseUrl },
    integrationSecret: 'whs',
  });

  const issues = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status)
    VALUES (${projectId}, ${ownerId}, ${Math.floor(Math.random() * 1_000_000)},
            'the merge is the stamp', 'in_progress')
    RETURNING id
  `);
  issueId = (issues[0] as { id: string }).id;

  const pulls = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO repo_pull_requests
      (project_id, binding_id, issue_id, number, repo_full_name, title, state,
       head_ref, head_sha, base_ref, base_sha)
    VALUES (${projectId}, ${binding.id}, ${issueId}, ${NUMBER}, ${`${OWNER}/${REPO}`},
            'the merge is the stamp', 'open', 'ISS-1073-merge', ${HEAD}, 'main', ${'b'.repeat(40)})
    RETURNING id
  `);
  pullRequestId = (pulls[0] as { id: string }).id;
});

async function stamp() {
  const rows = await harness.db.execute<Record<string, unknown>>(sql`
    SELECT merged_at, merged_commit_sha FROM issues WHERE id = ${issueId}
  `);
  const row = rows[0] as { merged_at: Date | string | null; merged_commit_sha: string | null };
  return {
    mergedAt: row.merged_at === null ? null : new Date(row.merged_at),
    commitSha: row.merged_commit_sha,
  };
}

async function projection() {
  const rows = await harness.db.execute<Record<string, unknown>>(sql`
    SELECT state, merge_commit_sha, merged_at FROM repo_pull_requests WHERE id = ${pullRequestId}
  `);
  return rows[0] as { state: string; merge_commit_sha: string | null; merged_at: Date | string };
}

async function deliveries() {
  const rows = await harness.db.execute<Record<string, unknown>>(sql`
    SELECT event_name, status FROM integration_deliveries ORDER BY created_at
  `);
  return rows as unknown as Array<{ event_name: string; status: string }>;
}

function merges() {
  return dbl.seen.filter((s) => s.method === 'PUT' && s.url.endsWith('/merge'));
}

describe('one operation writes the stamp, the evidence and the projection', () => {
  it('lands all three from a single call, with GitHub’s own merge time', async () => {
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });

    expect(outcome?.kind).toBe('merged');
    expect(merges()).toHaveLength(1);

    const marked = await stamp();
    expect(marked.commitSha).toBe(MERGE_COMMIT);
    expect(marked.mergedAt?.toISOString()).toBe(new Date(GITHUB_MERGED_AT).toISOString());

    const pr = await projection();
    expect(pr.state).toBe('merged');
    expect(pr.merge_commit_sha).toBe(MERGE_COMMIT);
    expect(new Date(pr.merged_at).toISOString()).toBe(new Date(GITHUB_MERGED_AT).toISOString());

    expect(await deliveries()).toEqual([
      expect.objectContaining({ event_name: 'pull_request.merge', status: 'ok' }),
    ]);
  });

  it('merges as the App and sends no person’s credential anywhere', async () => {
    await mods.mergeStoredPullRequest({ pullRequestId, requestedBy: `user:${ownerId}` });

    const mint = dbl.seen.filter((s) => s.url.includes('/access_tokens'));
    expect(mint.length).toBeGreaterThanOrEqual(1);
    // The mint is the App's own JWT (three dot-separated RS256 segments), and every
    // request after it carries the installation token the double issued. There is no
    // third identity available on this path — no PAT, no `gh` login, no user token.
    expect(mint[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const rest = dbl.seen.filter((s) => !s.url.includes('/access_tokens'));
    expect(rest.length).toBeGreaterThan(0);
    for (const call of rest) expect(call.auth).toBe('Bearer ghs_installation_token');
  });

  it('sends the head sha and the method and nothing that could bypass protection', async () => {
    await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
      method: 'squash',
    });
    expect(merges()[0]?.body).toEqual({ sha: HEAD, merge_method: 'squash' });
  });

  it('merges a branch whose protection has enforce_admins on, because nothing here bypasses', async () => {
    // Outcome 5, proved against THIS DOUBLE and nowhere else: the path never had an
    // admin override to lose, so a protection that admits none changes nothing about it.
    dbl.protection = {
      status: 200,
      body: {
        required_status_checks: { contexts: ['ci-passed'] },
        enforce_admins: { enabled: true },
      },
    };
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });
    expect(outcome?.kind).toBe('merged');
    expect(merges()[0]?.body).toEqual({ sha: HEAD, merge_method: 'merge' });
  });
});

describe('a second call is a reading of one merge, not a second merge', () => {
  it('writes no second PUT and leaves the recorded evidence exactly as it was', async () => {
    const first = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });
    expect(first?.kind).toBe('merged');
    const after = await stamp();

    const second = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });
    expect(second?.kind).toBe('already-merged');
    expect(merges()).toHaveLength(1);
    expect(await stamp()).toEqual(after);
  });
});

describe('a merge that cannot be made is refused by name', () => {
  it('sends no PUT at all when a required check has not passed, and stamps nothing', async () => {
    dbl.checks = [{ name: 'ci-passed', status: 'completed', conclusion: 'failure' }];
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });

    expect(outcome?.kind).toBe('refused');
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('required-check');
    expect(outcome?.kind === 'refused' && outcome.detail).toContain('ci-passed');
    expect(merges()).toHaveLength(0);
    expect(await stamp()).toEqual({ mergedAt: null, commitSha: null });
    expect((await projection()).state).toBe('open');
    expect(await deliveries()).toEqual([
      expect.objectContaining({ event_name: 'pull_request.merge', status: 'failed' }),
    ]);
  });

  it('refuses a head that moved rather than merging whatever is there now', async () => {
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
      expectedHeadSha: 'd'.repeat(40),
    });
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('head-moved');
    expect(merges()).toHaveLength(0);
    expect(await stamp()).toEqual({ mergedAt: null, commitSha: null });
  });

  it('refuses when the protection cannot be read, rather than merging on the difference', async () => {
    dbl.protection = { status: 403, body: { message: 'Resource not accessible by integration' } };
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('protection-unreadable');
    expect(merges()).toHaveLength(0);
    expect(await stamp()).toEqual({ mergedAt: null, commitSha: null });
  });
});

describe('the stamp announces the contract input it moved', () => {
  /** Every `contractInputChanged` the merge emits, on the one bus `merge.ts:announce` uses. */
  function listen(name: string) {
    const heard: Array<{ projectId: string; issueId?: string; reason?: string }> = [];
    mods.hooks.on('contractInputChanged', async (p) => void heard.push(p), { name });
    return heard;
  }

  it('emits contractInputChanged naming the issue and the kernel as the reason', async () => {
    const heard = listen('merge-announce-test');
    const outcome = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });

    expect(outcome?.kind).toBe('merged');
    expect(heard).toEqual([{ projectId, issueId, reason: 'merged by the kernel' }]);
  });

  it('says nothing on a second reading of the same merge, which wrote no stamp', async () => {
    await mods.mergeStoredPullRequest({ pullRequestId, requestedBy: `user:${ownerId}` });
    const heard = listen('merge-announce-again-test');
    const second = await mods.mergeStoredPullRequest({
      pullRequestId,
      requestedBy: `user:${ownerId}`,
    });

    expect(second?.kind).toBe('already-merged');
    expect(second?.kind === 'already-merged' && second.stamped).toBe(false);
    expect(heard).toHaveLength(0);
  });

  it('says nothing when the merge was refused', async () => {
    dbl.checks = [{ name: 'ci-passed', status: 'completed', conclusion: 'failure' }];
    const heard = listen('merge-announce-refused-test');
    expect(
      (await mods.mergeStoredPullRequest({ pullRequestId, requestedBy: `user:${ownerId}` }))?.kind,
    ).toBe('refused');
    expect(heard).toHaveLength(0);
  });
});
