/**
 * ISS-1386 — a release batch on a promote chain names every issue its range carries, and opens
 * only once each holds a decision. Measured on sid-desk and sidpeak: an issue parked at
 * `needs_info` or `testing`, whose landing sat on staging, shipped with a batch that never named
 * it. Real Postgres, the real create route, and a GitHub double answering the promotion range.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DoubleCommit,
  type GitHubDouble,
  startGitHubDouble,
} from '../helpers/github-double.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const sha = (c: string) => c.repeat(40);
const BASE = sha('0');

let harness: TestDatabase;
let server: TestServer;
let repo: GitHubDouble;
let projectId: string;
let ownerId: string;
let jwt: string;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  server = await startTestServer();
  repo = await startGitHubDouble();
}, 120_000);

afterAll(async () => {
  await repo?.close();
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  repo.reset();
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

/** `main` stands at the last commit, and `production...main` carries every one of them. */
function staging(commits: DoubleCommit[]): void {
  const head = commits.at(-1)?.sha ?? BASE;
  repo.heads.set('main', head);
  repo.compare.set(`production...${head}`, { status: 'ahead', commits });
}

const commit = (c: string, parent: string, message?: string): DoubleCommit => ({
  sha: sha(c),
  parents: [parent],
  ...(message ? { message } : {}),
});

async function landed(status: string, landing: string): Promise<string> {
  const id = await fx.insertIssue(status);
  await harness.db.execute(sql`UPDATE issues SET merged_commit_sha = ${landing} WHERE id = ${id}`);
  return id;
}

type Body = Record<string, unknown> & { code?: string; details?: Record<string, unknown> };

async function press(body: Record<string, unknown>): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/release-batches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function openRuns(): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM pipeline_runs
    WHERE project_id = ${projectId} AND status IN ('running', 'paused')
  `);
  return Number(rows[0]?.n ?? 0);
}

async function promptOf(runId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT payload ->> 'promptString' AS prompt FROM jobs WHERE pipeline_run_id = ${runId}
  `);
  return String(rows[0]?.prompt ?? '');
}

describe('a release batch names every issue its range carries', () => {
  beforeEach(async () => {
    await repo.bind(projectId, ownerId);
  });

  it('refuses a range carrying an undecided issue, naming each one at its status, and claims nothing', async () => {
    staging([
      commit('a', BASE),
      commit('b', sha('a')),
      commit('c', sha('b')),
      commit('d', sha('c')),
    ]);
    const roster = await landed('awaiting_release', sha('a'));
    const parked = await landed('needs_info', sha('b'));
    const closed = await landed('closed', sha('c'));
    const unnamed = await landed('awaiting_release', sha('d'));
    const [parkedId, closedId, unnamedId] = await fx.displayIds([parked, closed, unnamed]);

    const res = await press({ issueIds: [roster] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_CARRIES_UNDECIDED');
    const named = (
      (res.body.details?.carried ?? []) as Array<{ displayId: string; status: string }>
    ).map((i) => [i.displayId, i.status]);
    expect(named).toEqual([
      [parkedId, 'needs_info'],
      [closedId, 'closed'],
      [unnamedId, 'awaiting_release'],
    ]);
    expect(JSON.stringify(res.body)).toContain(`\`${parkedId}\` at \`needs_info\``);
    expect((await fx.stored(roster)).status).toBe('awaiting_release');
    expect((await fx.stored(roster)).claim).toBeNull();
    expect(await openRuns()).toBe(0);
  });

  it('opens with a ship-unverified decision, records it, says so on the issue, and tells the job', async () => {
    staging([commit('a', BASE), commit('b', sha('a'))]);
    const roster = await landed('awaiting_release', sha('a'));
    const parked = await landed('needs_info', sha('b'));
    const why = 'criterion 2 needs payroll writes on the shared tenant';

    const res = await press({
      issueIds: [roster],
      carried: [{ issueId: parked, decision: 'ship-unverified', why }],
    });

    expect(res.status).toBe(201);
    const runId = String(res.body.runId);
    expect(res.body.carried).toMatchObject({
      kind: 'read',
      cut: sha('b'),
      issues: [{ issueId: parked, decision: 'ship-unverified', why }],
    });
    const meta = await harness.db.execute(
      sql`SELECT metadata FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect((meta[0]?.metadata as Record<string, unknown> | undefined)?.carried).toMatchObject({
      issues: [{ issueId: parked, decision: 'ship-unverified' }],
    });
    const said = await harness.db.execute(
      sql`SELECT body FROM comments WHERE issue_id = ${parked}`,
    );
    const body = String(said.at(-1)?.body ?? '');
    expect(body).toContain(runId);
    expect(body).toContain(String(res.body.version));
    expect(body).toContain(why);
    const prompt = await promptOf(runId);
    expect(prompt).toContain(`Promote exactly \`${sha('b')}\``);
    expect(prompt).toContain('`ship-unverified`');
  });

  it('takes a decision for every carried issue when the range carries more than a roster holds', async () => {
    const shas = Array.from({ length: 52 }, (_, i) => (i + 1).toString(16).padStart(40, 'e'));
    staging(shas.map((s, i) => ({ sha: s, parents: [i === 0 ? BASE : (shas[i - 1] as string)] })));
    const roster = await landed('awaiting_release', shas[0] as string);
    const carried = [];
    for (const s of shas.slice(1)) {
      carried.push({
        issueId: await landed('needs_info', s),
        decision: 'ship-unverified',
        why: 'unjudged',
      });
    }

    const res = await press({ issueIds: [roster], carried });

    expect(res.status).toBe(201);
    expect((res.body.carried as { issues: unknown[] }).issues).toHaveLength(51);
  });

  it('accepts a revert where the range reverts the landing', async () => {
    const revert = commit('c', sha('b'), `Revert\n\nThis reverts commit ${sha('b')}.`);
    staging([commit('a', BASE), commit('b', sha('a')), revert]);
    const roster = await landed('awaiting_release', sha('a'));
    const parked = await landed('testing', sha('b'));

    const res = await press({
      issueIds: [roster],
      carried: [{ issueId: parked, decision: 'revert' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.carried).toMatchObject({ issues: [{ issueId: parked, decision: 'revert' }] });
  });

  it('refuses a revert the range does not hold, naming the issue', async () => {
    staging([commit('a', BASE), commit('b', sha('a'))]);
    const again = await landed('awaiting_release', sha('a'));
    const unreverted = await landed('testing', sha('b'));

    const refused = await press({
      issueIds: [again],
      carried: [{ issueId: unreverted, decision: 'revert' }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_CARRIED_DECISION_REFUSED');
    expect(JSON.stringify(refused.body.details)).toContain(unreverted);
  });

  it('cuts below a carried landing, so the release promotes its first parent', async () => {
    staging([commit('a', BASE), commit('b', sha('a'))]);
    repo.compare.set(`production...${sha('a')}`, { status: 'ahead', commits: [commit('a', BASE)] });
    const roster = await landed('awaiting_release', sha('a'));
    const parked = await landed('needs_info', sha('b'));

    const res = await press({
      issueIds: [roster],
      carried: [{ issueId: parked, decision: 'cut-below' }],
    });

    expect(res.status).toBe(201);
    expect(res.body.carried).toMatchObject({
      cut: sha('a'),
      issues: [],
      cutBelow: [{ issueId: parked }],
    });
    expect(await promptOf(String(res.body.runId))).toContain(`Promote exactly \`${sha('a')}\``);
  });

  it('refuses a cut-below that leaves a roster issue above the cut, naming it', async () => {
    staging([commit('a', BASE), commit('b', sha('a'))]);
    repo.compare.set(`production...${BASE}`, { status: 'identical', commits: [] });
    const parked = await landed('needs_info', sha('a'));
    const roster = await landed('awaiting_release', sha('b'));
    const [rosterId] = await fx.displayIds([roster]);

    const res = await press({
      issueIds: [roster],
      carried: [{ issueId: parked, decision: 'cut-below' }],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_CUT_DROPS_ROSTER');
    expect(res.body.details?.displayIds).toEqual([rosterId]);
  });

  it('refuses when the bound repository cannot answer the range, naming the check', async () => {
    repo.heads.set('main', sha('e'));
    const roster = await landed('awaiting_release', sha('a'));

    const res = await press({ issueIds: [roster] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('RELEASE_CHECK_UNEVALUATED');
    expect(res.body.details).toMatchObject({ check: 'carried' });
    expect(String(res.body.details?.detail)).toContain('production...');
  });
});

describe('where the range is not read', () => {
  it('opens a promote chain with no repository bound, and warns that nothing was read', async () => {
    const roster = await landed('awaiting_release', sha('a'));

    const res = await press({ issueIds: [roster] });

    expect(res.status).toBe(201);
    expect(res.body.carried).toMatchObject({ kind: 'unbound' });
    const warned = (res.body.warnings as Array<{ code: string; message: string }>).find(
      (w) => w.code === 'RELEASE_CARRIED_UNREAD',
    );
    expect(warned?.message).toContain('set an SSH clone URL and a deploy key');
    expect(warned?.message).not.toMatch(/Bind the repository|Integrations/);
  });

  it('opens a publish chain and says the range was not read', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET release_chain = '[{"branch": "main"}]'::jsonb WHERE id = ${projectId}
    `);
    const roster = await landed('awaiting_release', sha('a'));

    const res = await press({ issueIds: [roster] });

    expect(res.status).toBe(201);
    expect(res.body.carried).toMatchObject({ kind: 'not-read' });
    expect(String((res.body.carried as { why: string }).why)).toContain('deploys the branch');
  });
});
