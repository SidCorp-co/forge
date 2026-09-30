/**
 * ISS-1318 — an agent whose change landed on the base branch itself marks it merged with the
 * commit it landed at, and advances, against a real Postgres. The repository is a stand-in for
 * the project's GitHub binding: the reads `readCommitLanding` takes are answered from a table of
 * commits and of which branch holds which, so every refusal is driven by what the repository says.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const SEQ = 1318;
const OWN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const FOREIGN = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
const UNDECLARED = 'c3d4e5f60718293a4b5c6d7e8f90123456789ab';
const OFF_BASE = 'd4e5f60718293a4b5c6d7e8f90123456789abc0';
const ON_LIVE = 'e5f60718293a4b5c6d7e8f90123456789abcd01';
const FABRICATED = 'f60718293a4b5c6d7e8f90123456789abcde0123';

interface FakeCommit {
  message: string;
  on: string[];
}

const repo = {
  fullName: 'SidCorp-co/specimen',
  commits: new Map<string, FakeCommit>(),
  reads: [] as string[],
  down: null as string | null,
};

function httpError(status: number, path: string): Error {
  return Object.assign(new Error(`GET ${path} on ${repo.fullName} returned HTTP ${status}`), {
    status,
  });
}

vi.mock('../../src/integrations/github/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/github/client.js')>();
  const find = (ref: string): [string, FakeCommit] | undefined =>
    [...repo.commits.entries()].find(([sha]) => sha.startsWith(ref.toLowerCase()));
  return {
    ...real,
    githubRepoClient: vi.fn(async () => {
      if (repo.down === 'no_binding') {
        throw new real.GitHubClientError(
          'no_binding',
          'this project has no active GitHub binding — bind a repository on its Integrations page',
        );
      }
      return {
        bindingId: 'b',
        appId: '1',
        owner: 'SidCorp-co',
        repo: 'specimen',
        fullName: repo.fullName,
        publish: async () => {
          throw new Error('no publish in this test');
        },
        async get<T>(path: string): Promise<T> {
          repo.reads.push(path);
          if (repo.down === 'read')
            throw new real.GitHubReadError(502, httpError(502, path).message);
          const commit = /\/commits\/([^/]+)$/.exec(path);
          if (commit?.[1]) {
            const hit = find(decodeURIComponent(commit[1]));
            if (!hit) throw new real.GitHubReadError(422, httpError(422, path).message);
            return {
              sha: hit[0],
              commit: { message: hit[1].message, committer: { date: '2026-09-30T09:00:00Z' } },
            } as T;
          }
          const cmp = /\/compare\/([0-9a-f]+)\.\.\.(.+)$/.exec(path);
          if (cmp?.[1] && cmp[2]) {
            const hit = find(cmp[1]);
            const branch = decodeURIComponent(cmp[2]);
            return { status: hit?.[1].on.includes(branch) ? 'ahead' : 'diverged' } as T;
          }
          throw new Error(`unexpected read ${path}`);
        },
      };
    }),
  };
});

let harness: TestDatabase;
let userId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  repo.reads.length = 0;
  repo.down = null;
  repo.commits = new Map<string, FakeCommit>([
    [OWN, { message: `fix(core): mark by commit (ISS-${SEQ})`, on: ['main'] }],
    [FOREIGN, { message: 'fix(core): something else (ISS-1316)', on: ['main'] }],
    [UNDECLARED, { message: `chore: tidy, see ISS-${SEQ}`, on: ['main'] }],
    [OFF_BASE, { message: `ISS-${SEQ}: work in progress`, on: ['ISS-1318-wip'] }],
    [ON_LIVE, { message: `hotfix: straight to production (ISS-${SEQ})`, on: ['production'] }],
  ]);
  userId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  await harness.db.execute(sql`UPDATE projects SET base_branch = 'main' WHERE id = ${projectId}`);
});

async function seed(
  opts: {
    status?: string;
    sessionContext?: Record<string, unknown>;
    kind?: string;
    seq?: number;
  } = {},
) {
  if (opts.kind) {
    await harness.db.execute(sql`UPDATE projects SET kind = ${opts.kind} WHERE id = ${projectId}`);
  }
  const id = randomUUID();
  await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
      VALUES (${id}, ${projectId}, ${opts.seq ?? SEQ}, 'base-branch landing', ${opts.status ?? 'in_progress'},
              ${userId}, ${JSON.stringify(opts.sessionContext ?? { worklog: { branch: 'main' } })}::jsonb)
    `);
  return { id, projectId, mergedAt: null };
}

const actor = (agency: 'agent' | 'human') => ({
  agency,
  commentAuthorId: userId,
  hookActor: { type: 'user' as const, id: userId, agency },
});

async function mark(
  issue: { id: string; projectId: string; mergedAt: Date | null },
  commit: string | undefined,
  agency: 'agent' | 'human' = 'agent',
  extra: { landing?: string } = {},
) {
  const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
  return applyMergeMarker({
    issue,
    op: 'mark',
    target: 'main',
    ...(commit ? { commit } : {}),
    ...extra,
    actor: actor(agency),
  });
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error('expected a refusal, and the call went through');
}

async function row(id: string) {
  const [r] = await harness.db.execute<{
    status: string;
    merged_at: unknown;
    merged_commit_sha: string | null;
  }>(sql`SELECT status, merged_at, merged_commit_sha FROM issues WHERE id = ${id}`);
  return r as { status: string; merged_at: unknown; merged_commit_sha: string | null };
}

async function advance(id: string, from: string, to: string) {
  const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
  return transitionIssueStatus(
    { id, projectId, status: from, reopenCount: 0 } as never,
    to as never,
    {
      type: 'user',
      id: userId,
      agency: 'agent',
    },
  );
}

async function comments(id: string): Promise<string[]> {
  const rows = await harness.db.execute<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at ASC`,
  );
  return [...rows].map((r) => r.body);
}

describe('ISS-1318 — a base-branch landing marked by its commit (real Postgres)', () => {
  it('accepts the commit, stores it observed, and lets the issue reach developed then testing (criteria 1-3)', async () => {
    const issue = await seed();

    const res = await mark(issue, OWN);

    expect(res.action).toBe('merged');
    expect(res.mark).toBe('observed');
    expect(res.markDetail).toContain(`read from ${repo.fullName} itself`);
    expect(res.markDetail).not.toContain('pull request');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
    expect((await comments(issue.id)).at(-1)).toContain(`read from ${repo.fullName} itself`);

    await advance(issue.id, 'in_progress', 'developed');
    await advance(issue.id, 'developed', 'testing');
    expect((await row(issue.id)).status).toBe('testing');
  });

  it('resolves an abbreviated commit to the full sha the repository holds (criterion 9)', async () => {
    const issue = await seed();
    await mark(issue, OWN.slice(0, 9));
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });

  it('accepts a commit the live branch holds and the base does not (criterion 1)', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET release_chain = ${JSON.stringify([
        { branch: 'main' },
        { branch: 'production', from: 'merge-branch' },
      ])}::jsonb WHERE id = ${projectId}
    `);
    const issue = await seed();
    const res = await mark(issue, ON_LIVE);
    expect(res.mark).toBe('observed');
    expect(res.markDetail).toContain('on production');
  });

  it.each([
    [
      'COMMIT_NOT_IN_REPOSITORY',
      FABRICATED,
      [FABRICATED, 'is not an object in SidCorp-co/specimen'],
    ],
    [
      'COMMIT_NOT_THIS_ISSUE',
      FOREIGN,
      [FOREIGN, '"fix(core): something else (ISS-1316)"', `does not declare ISS-${SEQ}`],
    ],
    ['COMMIT_NOT_THIS_ISSUE', UNDECLARED, [UNDECLARED, `"chore: tidy, see ISS-${SEQ}"`]],
    ['COMMIT_NOT_LANDED', OFF_BASE, [OFF_BASE, 'main does not contain it']],
  ] as const)(
    'refuses %s for %s, naming it, and writes nothing (criteria 4-6, 8)',
    async (code, commit, says) => {
      const issue = await seed();
      const before = await comments(issue.id);

      const refused = await refusal(() => mark(issue, commit));

      expect(refused.code).toBe(code);
      for (const s of says) expect(refused.message).toContain(s);
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(await comments(issue.id)).toEqual(before);
      const blocked = await refusal(() => advance(issue.id, 'in_progress', 'developed'));
      expect(blocked.code).toBe('NO_WORK_EVIDENCE');
    },
  );

  it.each([
    ['no_binding', 'no active GitHub binding'],
    ['read', 'HTTP 502'],
  ] as const)(
    'refuses COMMIT_UNVERIFIED when the repository cannot be read (%s) (criteria 7, 8)',
    async (down, says) => {
      repo.down = down;
      const issue = await seed();
      const refused = await refusal(() => mark(issue, OWN));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain(says);
      expect(refused.message).toContain('not taken as evidence unchecked');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    },
  );

  it('still refuses NO_WORK_EVIDENCE, naming the commit route, for a mark with no commit (criteria 10, 12)', async () => {
    const issue = await seed({ sessionContext: { branch: 'main' } });
    const refused = await refusal(() => mark(issue, undefined));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.message).toContain('`mark_merged` carrying `data.commit`');
    expect(repo.reads).toEqual([]);
  });

  it('still refuses developed and testing with the base branch recorded and no merged commit (criterion 11)', async () => {
    const issue = await seed();
    expect((await refusal(() => advance(issue.id, 'in_progress', 'developed'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
    const atDeveloped = await seed({ status: 'developed', seq: SEQ + 1 });
    expect((await refusal(() => advance(atDeveloped.id, 'developed', 'testing'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
  });

  it('keeps the commit a claim, and reads nothing, where the issue already has a branch (criterion 13)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1318-mark-landed-base' } });
    const res = await mark(issue, FABRICATED);
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain(`commit ${FABRICATED} is recorded here as this call's claim`);
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
    expect(repo.reads).toEqual([]);
  });

  it("reads nothing for a human's mark, with or without evidence (criterion 14)", async () => {
    const bare = await seed({ sessionContext: {} });
    expect((await mark(bare, FABRICATED, 'human')).mark).toBe('asserted');
    expect((await mark({ ...bare, mergedAt: new Date() }, undefined, 'human')).action).toBe(
      'already_merged',
    );
    expect(repo.reads).toEqual([]);
  });

  it('takes no commit route on an outside_git project (criterion 15)', async () => {
    const issue = await seed({ kind: 'website' });
    const refused = await refusal(() => mark(issue, OWN));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(repo.reads).toEqual([]);
  });
});
