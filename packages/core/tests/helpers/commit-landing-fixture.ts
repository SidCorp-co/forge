/**
 * A project's GitHub repository, stood in for by a table of commits and of which branch holds
 * which, against a real Postgres: what `readCommitLanding` and `resolveMarkCommit` read is answered
 * from it, so every refusal a mark meets is driven by what the repository says.
 *
 * A suite mocks two modules with the stand-ins below, each factory importing this file, and calls
 * `useCommitLandingWorld()` once at its top level.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import type * as GitHubClient from '../../src/integrations/github/client.js';
import type * as MergeRecord from '../../src/issues/merge-record.js';
import { setupTestDatabase, type TestDatabase } from './db.js';
import { createTestProject, createTestUser } from './factories.js';
import { truncateAll } from './truncate.js';

export const SEQ = 1318;
export const OWN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const FOREIGN = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a';
export const UNDECLARED = 'c3d4e5f60718293a4b5c6d7e8f90123456789ab';
export const OFF_BASE = 'd4e5f60718293a4b5c6d7e8f90123456789abc0';
export const ON_LIVE = 'e5f60718293a4b5c6d7e8f90123456789abcd01';
export const FABRICATED = 'f60718293a4b5c6d7e8f90123456789abcde0123';
/** Shares its first seven characters with OWN, so that prefix names two commits. */
export const OWN_TWIN = `${OWN.slice(0, 7)}${'0'.repeat(33)}`;

interface FakeCommit {
  message: string;
  on: string[];
}

export const repo = {
  fullName: 'SidCorp-co/specimen',
  commits: new Map<string, FakeCommit>(),
  reads: [] as string[],
  down: null as string | null,
  /** A merged pull request Forge projected for the issue, standing in for `repo_pull_requests`. */
  pullRequest: null as { commitSha: string; mergedAt: Date } | null,
};

/** `merge-record.js` with the projection's merged pull request taken from `repo.pullRequest`. */
export function fakeMergeRecord(real: typeof MergeRecord): typeof MergeRecord {
  return {
    ...real,
    observedMergeForIssue: vi.fn(
      async (...args: Parameters<typeof real.observedMergeForIssue>) =>
        repo.pullRequest ?? real.observedMergeForIssue(...args),
    ),
  };
}

function httpError(status: number, path: string): Error {
  return Object.assign(new Error(`GET ${path} on ${repo.fullName} returned HTTP ${status}`), {
    status,
  });
}

/** `client.js` with `githubRepoClient` answering from `repo`. */
export function fakeGitHubClient(real: typeof GitHubClient): typeof GitHubClient {
  // GitHub resolves a prefix only where exactly one commit starts with it, and answers 422 alike
  // for a prefix nothing starts with and for one several do (checked against the real API, ISS-1318).
  const find = (ref: string): [string, FakeCommit] | undefined => {
    const hits = [...repo.commits.entries()].filter(([sha]) => sha.startsWith(ref.toLowerCase()));
    return hits.length === 1 ? hits[0] : undefined;
  };
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
          if (repo.down === 'mint') {
            throw new real.GitHubReadError(404, 'minting an installation token: HTTP 404', 'mint');
          }
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
}

export type Issue = {
  id: string;
  projectId: string;
  mergedAt: Date | null;
  declaredLandingShape: null;
};
type Agency = 'agent' | 'human';

/** One database, user and project per suite, each test starting from an empty one and `repo` as
 *  it was seeded; the helpers act on whichever project the current test holds. */
export function useCommitLandingWorld() {
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
    repo.pullRequest = null;
    repo.commits = new Map<string, FakeCommit>([
      [OWN, { message: `fix(core): mark by commit (ISS-${SEQ})`, on: ['main'] }],
      [FOREIGN, { message: 'fix(core): something else (ISS-1316)', on: ['main'] }],
      [UNDECLARED, { message: `chore: tidy, see ISS-${SEQ}`, on: ['main'] }],
      [OFF_BASE, { message: `ISS-${SEQ}: work in progress`, on: ['ISS-1318-wip'] }],
      [ON_LIVE, { message: `hotfix: straight to production (ISS-${SEQ})`, on: ['production'] }],
      [OWN_TWIN, { message: 'chore: an unrelated commit sharing a prefix', on: ['main'] }],
    ]);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
    await harness.db.execute(sql`UPDATE projects SET base_branch = 'main' WHERE id = ${projectId}`);
  });

  const actor = (agency: Agency) => ({
    agency,
    commentAuthorId: userId,
    hookActor: { type: 'user' as const, id: userId, agency },
  });

  return {
    current(): { db: TestDatabase['db']; projectId: string } {
      return { db: harness.db, projectId };
    },

    async setBaseBranch(branch: string | null): Promise<void> {
      await harness.db.execute(
        sql`UPDATE projects SET base_branch = ${branch} WHERE id = ${projectId}`,
      );
    },

    async withLiveBranch(): Promise<void> {
      await harness.db.execute(sql`
        UPDATE projects SET release_chain = ${JSON.stringify([
          { branch: 'main' },
          { branch: 'production', from: 'merge-branch' },
        ])}::jsonb WHERE id = ${projectId}
      `);
    },

    async declareWorkEvidence(): Promise<void> {
      await harness.db.execute(sql`
        UPDATE projects SET agent_config = ${JSON.stringify({
          pipelineConfig: { statusEntryCriteria: { developed: ['work_evidence'] } },
        })}::jsonb WHERE id = ${projectId}
      `);
    },

    async seed(
      opts: {
        status?: string;
        sessionContext?: Record<string, unknown>;
        kind?: string;
        seq?: number;
      } = {},
    ): Promise<Issue> {
      if (opts.kind) {
        await harness.db.execute(
          sql`UPDATE projects SET kind = ${opts.kind} WHERE id = ${projectId}`,
        );
      }
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
        VALUES (${id}, ${projectId}, ${opts.seq ?? SEQ}, 'base-branch landing', ${opts.status ?? 'in_progress'},
                ${userId}, ${JSON.stringify(opts.sessionContext ?? { worklog: { branch: 'main' } })}::jsonb)
      `);
      return { id, projectId, mergedAt: null, declaredLandingShape: null };
    },

    /** An implementation handoff recording `commitSha`, the commit a mark naming none falls back to. */
    async handoff(issueId: string, commitSha: string): Promise<void> {
      const runId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
      `);
      await harness.db.execute(sql`
        INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, payload)
        VALUES (${projectId}, ${issueId}, ${runId}, 'handoff', 'code', ${JSON.stringify({ commitSha })}::jsonb)
      `);
    },

    async mark(
      issue: Issue,
      commit: string | undefined,
      agency: Agency = 'agent',
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
    },

    /** The mark taken back, by `agency`. */
    async unmark(issue: Issue, agency: Agency = 'agent') {
      const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
      return applyMergeMarker({
        issue: { ...issue, mergedAt: new Date() },
        op: 'unmark',
        actor: actor(agency),
      });
    },

    async advance(id: string, from: string, to: string, agency: Agency = 'agent') {
      const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
      return transitionIssueStatus(
        { id, projectId, status: from, reopenCount: 0 } as never,
        to as never,
        { type: 'user', id: userId, agency },
      );
    },

    async row(id: string) {
      const [r] = await harness.db.execute<{
        status: string;
        merged_at: unknown;
        merged_commit_sha: string | null;
      }>(sql`SELECT status, merged_at, merged_commit_sha FROM issues WHERE id = ${id}`);
      return r as { status: string; merged_at: unknown; merged_commit_sha: string | null };
    },

    async comments(id: string): Promise<string[]> {
      const rows = await harness.db.execute<{ body: string }>(
        sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at ASC`,
      );
      return [...rows].map((r) => r.body);
    },
  };
}

export async function refusal(
  run: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error('expected a refusal, and the call went through');
}
