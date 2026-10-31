/**
 * ISS-809 / REQ-71 BC-9 — a project's declared validation gate is read where a release puts a commit
 * on production, against real Postgres with the source host planted. Split from `release-hold-e2e`,
 * whose setup it shares.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { RefusalError } from '../../src/lib/refusal.js';
import { runCoolifyDeploy } from '../../src/release-batch/coolify-commands.js';
import { createReleaseBatch } from '../../src/release-batch/create.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import {
  declareGate,
  fakeCoolify,
  landOnProduction,
  releaseWorld,
  seedProductionDeployTrigger,
  verdictComment,
} from '../helpers/release-world.js';

/**
 * The source host as a planted GitHub: it answers only where a test turns it on, so every other
 * case in this file reads the real resolver (no binding, no host). Each read is counted.
 */
const gateHost = vi.hoisted(() => ({
  on: false,
  reads: 0,
  head: 'f1bb20e6d3a94c0e8b71a2c5d4e9f0a1b2c3d4e5',
  committedAt: null as string | null,
  checks: [] as Array<Record<string, unknown>>,
  failWith: null as string | null,
  /**
   * GitHub's own answer, read through the real GitHub verbs (ISS-841): its check runs, and whether
   * its commit statuses answer 403 to the repository credential.
   */
  github: null as { checkRuns: Array<Record<string, unknown>>; statusForbidden: boolean } | null,
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>();
  const read = async <T>(answer: () => T): Promise<T> => {
    gateHost.reads += 1;
    if (gateHost.failWith) throw new Error(gateHost.failWith);
    return answer();
  };
  const planted = {
    provider: 'github',
    fullName: 'acme/test-project',
    branchHead: () => read(() => gateHost.head),
    readCommit: (ref: string) =>
      read(() => ({ sha: ref, message: 'a commit', committedAt: gateHost.committedAt })),
    readChecks: async (sha: string, opts?: { named?: string }) => {
      const github = gateHost.github;
      if (!github) return read(() => gateHost.checks.map((c) => ({ ...c, headSha: sha })));
      gateHost.reads += 1;
      const { githubChangeRequestVerbs } = await import(
        '../../src/integrations/github/change-requests.js'
      );
      const client = {
        fullName: 'acme/test-project',
        get: async (path: string) => {
          if (path.includes('/check-runs')) {
            return { total_count: github.checkRuns.length, check_runs: github.checkRuns };
          }
          if (github.statusForbidden) {
            throw new Error(`GET ${path} on acme/test-project returned HTTP 403`);
          }
          return { statuses: [] };
        },
      };
      return githubChangeRequestVerbs(client as never, () => ({}) as never).readChecks(sha, opts);
    },
    readChangeRequestChecks: ({ headSha }: { headSha: string }) =>
      read(() => gateHost.checks.map((c) => ({ ...c, headSha }))),
  };
  return {
    ...real,
    resolveSourceHost: (...args: Parameters<typeof real.resolveSourceHost>) =>
      gateHost.on ? Promise.resolve(planted as never) : real.resolveSourceHost(...args),
  };
});

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };

let projectId: string;
let ownerId: string;
let deploys = 0;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { holdOf, insertIssue, stored } = fx;

// a commit verdict emits `verdict.recorded`, whose delivery job needs the queue the server boots
beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  coolify.applications.clear();
  await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  await landOnProduction(projectId, ownerId);
  serve(SERVING);
  await fx.seedReleaseRunner();
});

/** Production's probe and the latest deployment Coolify records both answer `commit`. */
function serve(commit: string): void {
  fx.serve(commit);
  deploys += 1;
  coolify.deployed(
    APP.resourceUuid,
    `dep-${deploys}`,
    commit,
    new Date(Date.UTC(2026, 8, 29, 0, deploys)).toISOString(),
  );
}

function verdictBlock(criterion: number, verdict: string, at = `runtime: ${SERVING}`): string {
  return [
    `criterion: ${criterion}`,
    `verdict: ${verdict}`,
    at,
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

/** A waiting row whose criterion 1 carries `verdict` and whose criterion 2 passed. */
async function heldRow(verdict = 'skipped'): Promise<string> {
  const id = await insertIssue('awaiting_release', undefined, true, ['a', 'b']);
  const landing = JSON.stringify({ landing: { head: 'dce6f354c', deployment: SERVING } });
  await db.execute(sql`UPDATE issues SET session_context = ${landing}::jsonb WHERE id = ${id}`);
  await fx.postVerdict(id, verdictComment([verdictBlock(1, verdict), verdictBlock(2, 'pass')]));
  return id;
}

const sweep = () => sweepAutomaticReleases();

/** The refusal a cut is answered with: its code, its words and whether it was read as a blocker. */
async function refusedCut(id: string): Promise<RefusalError> {
  const err = await createReleaseBatch({ projectId, issueIds: [id], userId: ownerId }).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof RefusalError)) throw new Error('the cut was not refused');
  return err;
}

const releaseRuns = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${projectId}`,
    )
  )[0]?.n;

/**
 * ISS-809 — `validation.gate` names the check a project's changes must pass, and the step that puts a
 * commit on production reads it at that commit: a red one is refused by name, a pending one is held, a
 * silent one is held saying how long it waited, an unreadable one is refused (REQ-71 BC-9). The host is
 * planted; what is asserted is what the cut, the sweep's hold and the deploy do with its answer.
 */
describe('a project’s declared validation gate is read where a commit reaches production', () => {
  const GATE = { type: 'github-check', name: 'gate' } as const;
  const run = (
    conclusion: string | null,
    status = 'completed',
    startedAt = '2026-10-30T10:21:05Z',
  ) => ({
    id: '9001',
    name: 'gate',
    app: 'github-actions',
    status,
    conclusion,
    detailsUrl: 'https://github.example/acme/test-project/actions/runs/9001',
    startedAt,
    completedAt: status === 'completed' ? '2026-10-30T10:25:00Z' : null,
  });
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  beforeEach(async () => {
    gateHost.on = true;
    gateHost.reads = 0;
    gateHost.checks = [];
    gateHost.failWith = null;
    gateHost.github = null;
    gateHost.committedAt = minutesAgo(5);
    await declareGate(projectId, GATE);
  });

  afterAll(() => {
    gateHost.on = false;
  });

  it('refuses a cut at a head where the check is red, naming the check, the commit and the conclusion', async () => {
    const id = await heldRow('pass');
    gateHost.checks = [run('failure')];

    const err = await refusedCut(id);

    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_RED');
    expect(err.refusals[0]?.detail).toContain('`gate`');
    expect(err.refusals[0]?.detail).toContain(gateHost.head.slice(0, 12));
    expect(err.refusals[0]?.detail).toContain('failure');
    expect(await releaseRuns()).toBe(0);
    expect((await stored(id)).claim).toBeNull();
  });

  it('reads a re-run before the run it replaced, so a red that was re-run green is a pass', async () => {
    const id = await heldRow('pass');
    gateHost.checks = [
      { ...run('failure'), id: '9001', startedAt: '2026-10-30T10:00:00Z' },
      { ...run('success'), id: '9002', startedAt: '2026-10-30T10:30:00Z' },
    ];

    const result = await createReleaseBatch({ projectId, issueIds: [id], userId: ownerId });

    expect(result.issueIds).toEqual([id]);
  });

  it('holds the sweep’s waiting rows under PENDING while the check runs, and cuts them once it passes', async () => {
    const id = await heldRow('pass');
    gateHost.checks = [run(null, 'in_progress')];

    const first = await sweep();

    expect(first.issuesCut).toBe(0);
    const held = await holdOf(id);
    expect(held?.code).toBe('RELEASE_GATE_CHECK_PENDING');
    expect(held?.reason).toContain('`gate`');
    expect(held?.reason).toContain('still running');
    expect(held?.owes).toBe('agent');
    expect(await releaseRuns()).toBe(0);

    const again = await sweep();
    expect(again.holdsWritten, 'the same wait is not a new hold each tick').toBe(0);

    gateHost.checks = [run('success')];
    const result = await sweep();
    expect(result.issuesCut).toBe(1);
    expect(await holdOf(id)).toBeNull();
  });

  it('says it waits, and since when, for a commit whose check has not reported yet', async () => {
    const id = await heldRow('pass');
    gateHost.committedAt = minutesAgo(5);

    const err = await refusedCut(id);

    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_PENDING');
    expect(err.refusals[0]?.detail).toContain('has not reported');
    expect(err.refusals[0]?.detail).toContain('30 minutes');
  });

  it('holds a check that never reports as SILENT, naming the wait and what clears it', async () => {
    const id = await heldRow('pass');
    gateHost.committedAt = minutesAgo(45);

    const result = await sweep();

    expect(result.issuesCut).toBe(0);
    const held = await holdOf(id);
    expect(held?.code).toBe('RELEASE_GATE_CHECK_SILENT');
    expect(held?.owes).toBe('human');
    expect(held?.reason).toContain('30 minutes');
    expect(held?.reason).toContain('validation.gate');
    expect(held?.reason).toContain(gateHost.head.slice(0, 12));
  });

  it('says the host gave no commit time, where it gave none, and still holds', async () => {
    const id = await heldRow('pass');
    gateHost.committedAt = null;

    const err = await refusedCut(id);

    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_SILENT');
    expect(err.refusals[0]?.detail).toContain('commit time');
  });

  it('refuses by name, never reading it as a pass, where the host cannot answer', async () => {
    const id = await heldRow('pass');
    gateHost.failWith = 'GitHub answered 502';

    const err = await refusedCut(id);

    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_UNREAD');
    expect(err.refusals[0]?.detail).toContain('GitHub answered 502');
    expect(await releaseRuns()).toBe(0);
  });

  it('cuts where the check passes at the head', async () => {
    const passing = await heldRow('pass');
    gateHost.checks = [run('success')];

    const cut = await createReleaseBatch({ projectId, issueIds: [passing], userId: ownerId });

    expect(cut.issueIds).toEqual([passing]);
    expect(gateHost.reads).toBeGreaterThan(0);
  });

  it('cuts where the gate is none without any read of the host, red check or not', async () => {
    await declareGate(projectId, { type: 'none' });
    gateHost.checks = [run('failure')];
    const other = await heldRow('pass');

    const none = await createReleaseBatch({ projectId, issueIds: [other], userId: ownerId });

    expect(none.issueIds).toEqual([other]);
    expect(gateHost.reads).toBe(0);
  });

  it('refuses a release run’s deploy while the head its branch deploys is not a pass', async () => {
    const id = await heldRow('pass');
    gateHost.checks = [run('success')];
    const cut = await fx.claim([id]);
    gateHost.checks = [run('failure')];

    const err = await runCoolifyDeploy({ projectId, pipelineRunId: cut.runId }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).refusals[0]?.code).toBe('RELEASE_GATE_CHECK_RED');
    expect((err as RefusalError).refusals[0]?.detail).toContain('`gate`');
  });

  it('is not relaxed by the yolo profile', async () => {
    await declareGate(projectId, GATE, 'yolo');
    const id = await heldRow('pass');
    gateHost.checks = [run('failure')];

    const err = await refusedCut(id);

    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_RED');
  });
});

// ISS-841 (FB-437, agenfold 2026-10-31): the gate is a GitHub Actions job, green as a check run,
// and the repository credential gets 403 on commit statuses. Read through the real GitHub verbs.
describe('an Actions gate read through GitHub, where commit statuses answer 403', () => {
  beforeEach(async () => {
    gateHost.on = true;
    gateHost.failWith = null;
    gateHost.committedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await declareGate(projectId, { type: 'github-check', name: 'gate' });
  });

  afterAll(() => {
    gateHost.on = false;
    gateHost.github = null;
  });

  const actionsRun = (conclusion: string) => ({
    id: 9001,
    name: 'gate',
    head_sha: gateHost.head,
    status: 'completed',
    conclusion,
    app: { slug: 'github-actions' },
  });

  it('cuts on a green gate check run, never reading the forbidden statuses', async () => {
    const id = await heldRow('pass');
    gateHost.github = { checkRuns: [actionsRun('success')], statusForbidden: true };
    const result = await createReleaseBatch({ projectId, issueIds: [id], userId: ownerId });
    expect(result.issueIds).toEqual([id]);
  });

  it('still refuses a red gate check run by name', async () => {
    const id = await heldRow('pass');
    gateHost.github = { checkRuns: [actionsRun('failure')], statusForbidden: true };
    const err = await refusedCut(id);
    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_RED');
    expect(err.refusals[0]?.detail).toContain('failure');
    expect(await releaseRuns()).toBe(0);
  });

  it('still refuses as unread where no check run carries the gate and statuses are forbidden', async () => {
    const id = await heldRow('pass');
    gateHost.github = { checkRuns: [], statusForbidden: true };
    const err = await refusedCut(id);
    expect(err.refusals[0]?.code).toBe('RELEASE_GATE_CHECK_UNREAD');
    expect(err.refusals[0]?.detail).toContain('HTTP 403');
  });
});
