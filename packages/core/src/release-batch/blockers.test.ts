/**
 * The enumerator, judged on the property the issue is about: a report that is
 * empty is a claim that the create succeeds, and a report that is non-empty
 * names EVERY reason rather than the first one the door happened to reach.
 *
 * So the cases below are mostly about what the report contains BESIDE the thing
 * being tested. A check that reports one true reason and swallows a second is
 * exactly the defect ISS-1127 was filed for, and it passes any test that only
 * asserts the first.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Object.assign(selectRows(), { limit: selectLimit }) }),
    }),
    execute: () => execRows(),
  },
}));

const listBindings = vi.fn(async () => [] as unknown[]);
vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const onlineIds = vi.fn(async () => [] as string[]);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: (...a: unknown[]) => onlineIds(...(a as [])),
}));

const activeBatch = vi.fn(async () => null as { runId: string } | null);
vi.mock('./queries.js', async (importActual) => {
  const actual = await importActual<typeof import('./queries.js')>();
  return { ...actual, getActiveReleaseBatch: () => activeBatch() };
});

const missingNotes = vi.fn(async () => [] as string[]);
vi.mock('../issues/release-record-required.js', async (importActual) => {
  const actual = await importActual<typeof import('../issues/release-record-required.js')>();
  return { ...actual, issuesMissingReleaseRecord: () => missingNotes() };
});

const { collectReleaseBlockers, releaseBlockerError } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ISSUE_A = '66666666-6666-4666-8666-666666666666';
const ISSUE_B = '77777777-7777-4777-8777-777777777777';

const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };

function projectRow(over: Record<string, unknown> = {}) {
  selectLimit.mockResolvedValue([
    {
      repoPath: '/srv/app',
      repoUrl: null,
      baseBranch: 'main',
      liveBranch: null,
      releaseModel: 'publish',
      releaseStrategy: null,
      environments: {
        live: { url: 'https://app.example.test', commitUrl: 'https://example.test/api/health' },
      },
      ...over,
    },
  ]);
}

function liveBinding(config: Record<string, unknown>) {
  listBindings.mockResolvedValue([
    {
      binding: {
        id: 'b-1',
        provider: 'coolify',
        config,
        instructions: null,
        label: '',
        role: 'deploy',
        stages: ['live'],
      },
      connection: { config: {} },
    },
  ]);
}

const DECLARED = {
  releaseRunnerLabel: 'prod-box',
  verify: PROBES,
  rollback: { mode: 'coolify-image' },
};

/** A project with nothing wrong with it, and one issue waiting. */
function ready() {
  projectRow();
  liveBinding(DECLARED);
  selectRows.mockResolvedValue([
    { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: new Date() },
  ]);
  execRows.mockResolvedValue([{ device_id: 'dev-1' }]);
  onlineIds.mockResolvedValue(['dev-1']);
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
  selectRows.mockResolvedValue([]);
  execRows.mockResolvedValue([]);
  onlineIds.mockResolvedValue([]);
  activeBatch.mockResolvedValue(null);
  missingNotes.mockResolvedValue([]);
});

describe('collectReleaseBlockers', () => {
  it('reports nothing for a project that can release, which is what makes an empty report a promise', async () => {
    ready();

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers).toEqual([]);
    expect(releaseBlockerError(report)).toBeNull();
  });

  it('names the roster reason AND the fleet reason in one report, not the first one reached', async () => {
    ready();
    missingNotes.mockResolvedValue([ISSUE_A]);
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue([]);

    const codes = (await collectReleaseBlockers(PROJECT_ID)).blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_RECORD_MISSING');
    expect(codes).toContain('RELEASE_POOL_EMPTY');
  });

  it('separates a fleet with nothing online from a fleet that does not exist', async () => {
    ready();
    onlineIds.mockResolvedValue([]);

    const codes = (await collectReleaseBlockers(PROJECT_ID)).blockers.map((b) => b.code);

    expect(codes).toContain('NO_RUNNER_ONLINE');
    expect(codes).not.toContain('RELEASE_POOL_EMPTY');
  });

  it('reports a release already running, which the create only met at enqueue', async () => {
    ready();
    activeBatch.mockResolvedValue({ runId: 'run-9' });

    const report = await collectReleaseBlockers(PROJECT_ID);
    const inflight = report.blockers.find((b) => b.code === 'BATCH_IN_FLIGHT');

    expect(inflight?.details).toMatchObject({ runId: 'run-9' });
  });

  it('reports an empty roster as a reason, because a create over it is refused by the schema', async () => {
    ready();
    selectRows.mockResolvedValue([]);

    const codes = (await collectReleaseBlockers(PROJECT_ID)).blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_ROSTER_EMPTY');
  });

  it('reports a roster larger than one release may carry, naming the count', async () => {
    ready();
    selectRows.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        id: `id-${i}`,
        status: 'awaiting_release',
        claimed: null,
      })),
    );

    const over = (await collectReleaseBlockers(PROJECT_ID)).blockers.find(
      (b) => b.code === 'RELEASE_ROSTER_OVERSIZE',
    );

    expect(over?.details).toMatchObject({ waiting: 51, limit: 50 });
    expect(over?.message).toContain('50');
  });

  it('names a probe url that is not a url, without making a request', async () => {
    ready();
    liveBinding({ ...DECLARED, verify: { probes: [{ url: 'example.test/version' }] } });

    const bad = (await collectReleaseBlockers(PROJECT_ID)).blockers.find(
      (b) => b.code === 'RELEASE_PROBES_UNREADABLE',
    );

    expect(bad?.details).toMatchObject({ urls: ['example.test/version'] });
  });

  it('answers with the check it could not run, and still runs the checks after it', async () => {
    ready();
    onlineIds.mockRejectedValue(new Error('pool table unreadable'));
    activeBatch.mockResolvedValue({ runId: 'run-9' });

    const report = await collectReleaseBlockers(PROJECT_ID);
    const unevaluated = report.blockers.find((b) => b.code === 'RELEASE_CHECK_UNEVALUATED');

    expect(unevaluated?.evaluated).toBe(false);
    expect(unevaluated?.details).toMatchObject({ check: 'runner-pool' });
    expect(report.blockers.map((b) => b.code)).toContain('BATCH_IN_FLIGHT');
  });

  it('keeps the order the door refuses in, so an earlier reason still wins the refusal', async () => {
    ready();
    missingNotes.mockResolvedValue([ISSUE_A]);
    onlineIds.mockRejectedValue(new Error('pool table unreadable'));

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers[0]?.code).toBe('RELEASE_RECORD_MISSING');
    expect(releaseBlockerError(report)?.name).toBe('ReleaseRecordMissingError');
  });

  it('carries every reason on the error the door throws, which is the whole point', async () => {
    ready();
    missingNotes.mockResolvedValue([ISSUE_A]);
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue([]);

    const err = releaseBlockerError(await collectReleaseBlockers(PROJECT_ID));

    expect(err?.releaseBlockers?.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('reports an unmet runner-label preference as a warning, never as a blocker', async () => {
    ready();
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue(['dev-1']);

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.warnings.map((w) => w.code)).toEqual(['RELEASE_RUNNER_PREFERENCE_UNMET']);
    expect(report.blockers).toEqual([]);
  });

  it('asks the record door for a merge and never for a runner', async () => {
    ready();
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue([]);
    selectRows.mockResolvedValue([
      { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: null },
    ]);

    const codes = (
      await collectReleaseBlockers(PROJECT_ID, { issueIds: [ISSUE_A], door: 'record' })
    ).blockers.map((b) => b.code);

    expect(codes).toContain('RELEASE_WORK_UNMERGED');
    expect(codes).not.toContain('RELEASE_POOL_EMPTY');
    expect(codes).not.toContain('NO_RUNNER_ONLINE');
  });

  it('names the note and the merge together, which the record door met minutes apart', async () => {
    ready();
    missingNotes.mockResolvedValue([ISSUE_A]);
    selectRows.mockResolvedValue([
      { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: null },
    ]);

    const err = releaseBlockerError(
      await collectReleaseBlockers(PROJECT_ID, { issueIds: [ISSUE_A], door: 'record' }),
    );

    expect(err?.name).toBe('ReleaseRecordMissingError');
    expect(err?.releaseBlockers?.map((b) => b.code)).toContain('RELEASE_WORK_UNMERGED');
  });

  it('refuses an issue that is not at the gate by the name the door already used', async () => {
    ready();
    selectRows.mockResolvedValue([{ id: ISSUE_A, status: 'developed', claimed: null }]);

    const err = releaseBlockerError(
      await collectReleaseBlockers(PROJECT_ID, { issueIds: [ISSUE_A, ISSUE_B] }),
    );

    expect(err?.name).toBe('ClaimConflictError');
  });

  it('says the project is absent rather than reporting a contract nobody owes', async () => {
    selectLimit.mockResolvedValue([]);

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.projectExists).toBe(false);
  });
});
