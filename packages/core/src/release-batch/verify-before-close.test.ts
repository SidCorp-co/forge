import type { ServingReading } from '@forge/contracts/releases';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import type { ReleaseChannel } from './plan.js';

const reads = vi.hoisted(() => ({
  channels: [] as ReleaseChannel[],
  serving: null as ServingReading | null,
  stamped: [] as unknown[],
}));

vi.mock('../pipeline/index.js', () => ({
  cancelConcludedRun: vi.fn(),
  closeRunIfOneShot: vi.fn(),
  stampReleaseShipped: vi.fn(),
  writeRunMetadata: vi.fn(async (_runId: string, patch: unknown) => {
    reads.stamped.push(patch);
  }),
}));
vi.mock('../issues/index.js', () => ({
  transitionIssueStatus: vi.fn(),
}));
vi.mock('./abort-stamp.js', () => ({
  abortedError: vi.fn(),
  batchAborted: () => false,
  closedBeforeAbort: vi.fn(),
  settleAbortStamp: vi.fn(),
  stampAbort: vi.fn(),
}));
vi.mock('./claim-conflicts.js', () => ({ refuseLostReleaseClaim: vi.fn() }));
vi.mock('./releasing-recovery.js', () => ({ recoverStrandedReleasing: vi.fn() }));
vi.mock('./channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel.js')>()),
  resolveReleaseChannels: async () => reads.channels,
}));
vi.mock('./serving-reading.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serving-reading.js')>()),
  readServingNow: async () => reads.serving,
}));

const { closeVerification } = await import('./channel.js');
const { verifyBeforeClose } = await import('./finish.js');

const SHIPPED = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

const noProbe: ReleaseChannel = {
  environment: 'production',
  bindingId: 'binding-1',
  provider: 'coolify',
  label: 'prod',
  instructions: null,
  verify: null,
  verifySource: 'none',
  providerRecord: false,
  rollback: null,
  releaseRunnerLabel: null,
};

const run = {
  projectId: 'project-1',
  metadata: { source: 'release-batch' },
  status: 'running' as const,
  releaseVersion: '1.2.3',
};

const deployed = (commit: string): ServingReading => ({
  kind: 'serving',
  served: [{ commit, where: 'coolify deployment d1 of environment `production`' }],
  unread: [],
  readAt: '2026-10-05T00:00:00.000Z',
});

async function refusalOf(p: Promise<unknown>): Promise<{ code: string; detail: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return err.refusals[0] as { code: string; detail: string };
  }
}

describe('act-release: a production with no source probe', () => {
  beforeEach(() => {
    reads.channels = [noProbe];
    reads.serving = null;
    reads.stamped = [];
  });

  it('is proved by the deployment record, never closed unverified', () => {
    expect(closeVerification([noProbe])).toEqual({ kind: 'deployment' });
  });

  it('refuses RELEASE_NOT_VERIFIED when nothing can show what production serves', async () => {
    reads.serving = { kind: 'undeclared', missing: 'no deployment record', route: 'declare one' };
    const onVerified = vi.fn();
    const refusal = await refusalOf(
      verifyBeforeClose('run-1', run, { commit: SHIPPED, onVerified }),
    );
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(refusal?.detail).toContain(`nothing can show this release is serving ${SHIPPED}`);
    expect(onVerified).not.toHaveBeenCalled();
    expect(reads.stamped).toEqual([]);
  });

  it('refuses RELEASE_NOT_VERIFIED when the deployment record names another commit', async () => {
    reads.serving = deployed(OLDER);
    const refusal = await refusalOf(verifyBeforeClose('run-1', run, { commit: SHIPPED }));
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
    expect(refusal?.detail).toContain(`not ${SHIPPED}`);
  });

  it('refuses RELEASE_NOT_VERIFIED when the finish names no commit to compare', async () => {
    reads.serving = deployed(SHIPPED);
    const refusal = await refusalOf(verifyBeforeClose('run-1', run, {}));
    expect(refusal?.code).toBe('RELEASE_NOT_VERIFIED');
  });

  it('closes once the deployment record names the commit, and stamps how', async () => {
    reads.serving = deployed(SHIPPED.slice(0, 12));
    const onVerified = vi.fn();
    await verifyBeforeClose('run-1', run, { commit: SHIPPED, onVerified });
    expect(onVerified).toHaveBeenCalledWith('deployment');
    expect(reads.stamped).toEqual([{ merge: { verification: 'deployment' }, touch: false }]);
  });
});
