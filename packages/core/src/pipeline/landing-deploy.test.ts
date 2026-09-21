/**
 * ISS-1152 — a landed change asks for its own deployment.
 *
 * The lane is `developed → testing → awaiting_release`. `testing` is earned by
 * verdicts against what is RUNNING, and until this subscriber existed the only
 * automatic deploy trigger filtered `jobCompleted` on `type === 'release'` — a
 * job type no producer in this repo creates. So an issue at `developed` had
 * nothing running that contained its change, and waited for an unrelated
 * issue's release to carry it out as a side effect.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeSelect(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(selectQueue.shift() ?? []),
  };
  return p;
}

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => makeSelect()) },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface DispatchArgs {
  projectId: string;
  issueId: string | null;
  runId: string;
}
const dispatchSpy = vi.fn(async (_args: DispatchArgs) => ({
  dispatched: true,
  pendingHumanConfirm: false,
  integrationIds: ['binding-1'],
}));
const resolveRunSpy = vi.fn(async (_issueId: string) => 'run-1' as string | null);
vi.mock('./release-coolify.js', () => ({
  tryDispatchCoolifyRelease: (args: unknown) => dispatchSpy(args as never),
  resolveLatestIssueRunId: (issueId: string) => resolveRunSpy(issueId),
}));

const { logger } = await import('../logger.js');
const { assertHookDelivered, HooksBus } = await import('./hooks.js');
const { LANDING_DEPLOY_SUBSCRIBER, registerLandedChangeDeploySubscriber } = await import(
  './landing-deploy.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';

const ACTOR = { type: 'device', id: 'dev-1', agency: 'agent' } as const;

function bus() {
  const b = new HooksBus();
  registerLandedChangeDeploySubscriber(b);
  return b;
}

function projectConfig(pipelineConfig: Record<string, unknown>): void {
  selectQueue.push([{ agentConfig: { pipelineConfig } }]);
}

function optedIn(): void {
  projectConfig({ enabled: true, deployOnLanding: true });
}

async function land(b: ReturnType<typeof bus>, to = 'developed'): Promise<void> {
  await b.emit('transition', {
    issueId: ISSUE_ID,
    projectId: PROJECT_ID,
    actor: ACTOR,
    // biome-ignore lint/suspicious/noExplicitAny: the status is the subject of the test
    from: 'in_progress' as any,
    // biome-ignore lint/suspicious/noExplicitAny: see above
    to: to as any,
    reopenCount: 0,
  });
}

beforeEach(() => {
  selectQueue.length = 0;
  dispatchSpy.mockClear();
  resolveRunSpy.mockClear();
  resolveRunSpy.mockImplementation(async () => 'run-1');
  vi.mocked(logger.error).mockClear();
});

describe('the landed change is what asks for the deployment', () => {
  it('dispatches a deploy when an issue arrives at developed', async () => {
    optedIn();
    await land(bus());
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
    });
  });

  it('dispatches nothing for a transition to any other status', async () => {
    for (const to of ['in_progress', 'testing', 'awaiting_release', 'closed', 'reopen']) {
      await land(bus(), to);
    }
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the project pipeline is not enabled', async () => {
    projectConfig({ enabled: false, deployOnLanding: true });
    await land(bus());
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('dispatches nothing for a project that did not opt into deployOnLanding', async () => {
    projectConfig({ enabled: true });
    await land(bus());
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('refuses a landing whose issue resolves to no run, at error level', async () => {
    optedIn();
    resolveRunSpy.mockImplementation(async () => null);
    await land(bus());
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('a dispatch that throws is a delivery failure the outbox owns, not a log line', async () => {
    optedIn();
    dispatchSpy.mockRejectedValueOnce(new Error('coolify is down'));
    const result = await bus().emit('transition', {
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      actor: ACTOR,
      // biome-ignore lint/suspicious/noExplicitAny: the status is the subject of the test
      from: 'in_progress' as any,
      // biome-ignore lint/suspicious/noExplicitAny: see above
      to: 'developed' as any,
      reopenCount: 0,
    });
    expect(result.failures.map((f) => f.subscriber)).toEqual([LANDING_DEPLOY_SUBSCRIBER]);
    expect(() => assertHookDelivered(result, { owned: [LANDING_DEPLOY_SUBSCRIBER] })).toThrow();
  });

  it('writes nothing onto the issue row — the deployment identity stays derived', async () => {
    optedIn();
    await land(bus());
    const call = dispatchSpy.mock.calls[0]?.[0];
    expect(Object.keys(call ?? {}).sort()).toEqual(['issueId', 'projectId', 'runId']);
  });
});

describe('a job completion is NOT what asks for it (the reproduction)', () => {
  it.each(['drive', 'release_batch', 'smoke', 'reconcile', 'verify_skill'])(
    'a completed %s job — the types an autonomous project emits — dispatches nothing',
    async (type) => {
      await bus().emit('jobCompleted', {
        jobId: 'job-1',
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        // biome-ignore lint/suspicious/noExplicitAny: the job type is the subject of the test
        type: type as any,
      });
      expect(dispatchSpy).not.toHaveBeenCalled();
    },
  );
});

// ISS-1152 — the trigger this replaced could not fire. Nothing produces a job
// of type `release`, so a `jobCompleted` subscriber that gates on it is a
// silent no-op: it reads like a live trigger, reports nothing, and dispatches
// nothing. This scans the source rather than importing it, because the defect
// is the existence of such a filter, not the behaviour of any one module.
describe('no subscriber gates jobCompleted on a job type nothing produces', () => {
  it('no file under packages/core/src compares a completed job type to "release"', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..');

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
      });

    const offenders = walk(root).filter((p) => {
      const src = readFileSync(p, 'utf8');
      if (!src.includes('jobCompleted')) return false;
      return /\.type\s*[!=]==\s*'release'/.test(src);
    });

    expect(offenders).toEqual([]);
  });
});
