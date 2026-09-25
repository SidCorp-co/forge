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

// The claim check joins the issue's project and claiming run; a join reads the same rows.
const fromChain: Record<string, unknown> = {};
fromChain.where = () => Object.assign(selectRows(), { limit: selectLimit });
fromChain.innerJoin = fromChain.leftJoin = () => fromChain;
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => fromChain }),
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

const { alsoBlocking, collectReleaseBlockers, releaseBlockerError } = await import('./blockers.js');
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

  it('reports an empty roster as a reason, which a create over it is refused by', async () => {
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

  // The create door names its list; a named list answers to the same limit.
  it('sizes a named list by the same limit, and names the count it was handed', async () => {
    ready();
    const named = Array.from({ length: 51 }, (_, i) => `named-${i}`);

    const report = await collectReleaseBlockers(PROJECT_ID, { issueIds: named });
    const over = report.blockers.find((b) => b.code === 'RELEASE_ROSTER_OVERSIZE');

    expect(over?.details).toEqual({ waiting: 51, limit: 50 });
    expect(over?.scope).toBe('roster');
  });

  it('holds fifty named issues to no size reason', async () => {
    ready();
    const named = Array.from({ length: 50 }, (_, i) => `named-${i}`);

    const codes = (await collectReleaseBlockers(PROJECT_ID, { issueIds: named })).blockers.map(
      (b) => b.code,
    );

    expect(codes).not.toContain('RELEASE_ROSTER_OVERSIZE');
  });

  it('answers an empty named list against an empty gate as the empty roster', async () => {
    ready();
    selectRows.mockResolvedValue([]);

    const codes = (await collectReleaseBlockers(PROJECT_ID, { issueIds: [] })).blockers.map(
      (b) => b.code,
    );

    expect(codes).toContain('RELEASE_ROSTER_EMPTY');
  });

  it('carries none of a waiting gate into an empty named list', async () => {
    ready();

    const report = await collectReleaseBlockers(PROJECT_ID, { issueIds: [] });

    expect(report.blockers).toEqual([]);
    expect(missingNotes).not.toHaveBeenCalled();
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

  // ISS-1127's outcome is that every reason is visible AT ONCE. An empty pool and
  // an unmet label are two facts, and an operator holding both is the state
  // forge-dev was in when this was found: two runners, `labels: []`, a declared
  // `release` label, and `warnings: []` on the answer.
  it('says the label is unmet even when no box is online to rank', async () => {
    ready();
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue([]);

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
    expect(report.warnings.map((w) => w.code)).toContain('RELEASE_RUNNER_PREFERENCE_UNMET');
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

/**
 * The whole-set review's F1, F2 and F4: three ways the enumerator could change
 * what a caller already got for a state that has not moved.
 */
describe('collectReleaseBlockers — nothing a caller already got may move', () => {
  it('throws the target refusal under its own class, which is what keeps it a 409', async () => {
    projectRow({ releaseModel: 'publish' });
    listBindings.mockResolvedValue([]);

    const err = releaseBlockerError(await collectReleaseBlockers(PROJECT_ID));

    expect(err?.name).toBe('ReleaseTargetUndeclaredError');
  });

  it('refuses a project missing BOTH a branch and one binding by the branch, as create did', async () => {
    ready();
    projectRow({ baseBranch: null, releaseModel: 'publish' });
    listBindings.mockResolvedValue([
      {
        binding: {
          id: 'b-1',
          provider: 'coolify',
          config: DECLARED,
          instructions: null,
          label: '',
          role: 'deploy',
          stages: ['live'],
        },
        connection: { config: {} },
      },
      {
        binding: {
          id: 'b-2',
          provider: 'coolify',
          config: DECLARED,
          instructions: null,
          label: 'two',
          role: 'deploy',
          stages: ['live'],
        },
        connection: { config: {} },
      },
    ]);
    selectRows.mockResolvedValue([{ id: ISSUE_A, status: 'awaiting_release', claimed: null }]);

    const codes = (await collectReleaseBlockers(PROJECT_ID)).blockers.map((b) => b.code);

    expect(codes.indexOf('RELEASE_BRANCHES_UNDECLARED')).toBeLessThan(
      codes.indexOf('RELEASE_MULTI_CHANNEL_UNSUPPORTED'),
    );
  });

  it('says the channels were not read, rather than answering as though none were declared', async () => {
    projectRow();
    listBindings.mockRejectedValue(new Error('binding store unreachable'));

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.channels).toBeNull();
    expect(report.blockers.map((b) => b.code)).toContain('RELEASE_CHECK_UNEVALUATED');
  });
});

/**
 * The second whole-set read's F1, F2 and F3: three more ways an answer could
 * be less than every reason, or a different one than a caller already got.
 */
describe('collectReleaseBlockers — each door in its own refusal order', () => {
  it('does not let a failed channel read outrank a roster reason the batch door reached first', async () => {
    ready();
    missingNotes.mockResolvedValue([ISSUE_A]);
    // The declaration reads the bindings too, so only the SECOND read fails —
    // a channel resolution that broke under a declaration that answered.
    const bindings = await listBindings();
    listBindings.mockReset();
    listBindings.mockResolvedValueOnce(bindings);
    listBindings.mockRejectedValue(new Error('binding store unreachable'));

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers[0]?.code).toBe('RELEASE_RECORD_MISSING');
    expect(report.blockers.map((b) => b.code)).toContain('RELEASE_CHECK_UNEVALUATED');
  });

  it('refuses a record by the probes, as that door did, and carries the roster with it', async () => {
    ready();
    // No binding probe AND no project-level live endpoint, or the channel takes
    // the project's fallback and declares probes after all.
    projectRow({ environments: {} });
    liveBinding({ releaseRunnerLabel: 'prod-box', rollback: { mode: 'coolify-image' } });
    missingNotes.mockResolvedValue([ISSUE_A]);
    selectRows.mockResolvedValue([
      { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: null },
    ]);

    const err = releaseBlockerError(
      await collectReleaseBlockers(PROJECT_ID, { issueIds: [ISSUE_A], door: 'record' }),
    );

    expect(err?.name).toBe('ReleaseProbesUndeclaredError');
    const rest = err?.releaseBlockers?.map((b) => b.code) ?? [];
    expect(rest).toContain('RELEASE_RECORD_MISSING');
    expect(rest).toContain('RELEASE_WORK_UNMERGED');
  });

  it('keeps a second unevaluated check when the first is the one being thrown', async () => {
    ready();
    onlineIds.mockRejectedValue(new Error('pool table unreadable'));
    activeBatch.mockRejectedValue(new Error('runs table unreadable'));

    const report = await collectReleaseBlockers(PROJECT_ID);
    const err = releaseBlockerError(report);
    const standing = alsoBlocking(err, 'RELEASE_CHECK_UNEVALUATED');

    expect(standing.filter((b) => b.code === 'RELEASE_CHECK_UNEVALUATED')).toHaveLength(1);
  });
});

/**
 * `RELEASE_PROBES_UNREADABLE` is a reason this change ADDS, so it belongs where
 * the live read stands — the last thing either door does before it acts. Added
 * any earlier, it displaces a refusal the caller already gets for that project.
 */
describe('collectReleaseBlockers — a new reason may not displace an old one', () => {
  const MALFORMED = {
    releaseRunnerLabel: 'prod-box',
    rollback: { mode: 'coolify-image' },
    verify: { probes: [{ url: 'example.test/version' }] },
  };

  it('refuses a batch by the empty fleet, and carries the malformed probe with it', async () => {
    ready();
    projectRow({ environments: {} });
    liveBinding(MALFORMED);
    execRows.mockResolvedValue([]);
    onlineIds.mockResolvedValue([]);

    const report = await collectReleaseBlockers(PROJECT_ID);
    const codes = report.blockers.map((b) => b.code);

    expect(report.blockers[0]?.code).toBe('RELEASE_POOL_EMPTY');
    expect(codes).toContain('RELEASE_PROBES_UNREADABLE');
  });

  it('refuses a record by the missing note, and carries the malformed probe with it', async () => {
    ready();
    projectRow({ environments: {} });
    liveBinding(MALFORMED);
    missingNotes.mockResolvedValue([ISSUE_A]);

    const report = await collectReleaseBlockers(PROJECT_ID, {
      issueIds: [ISSUE_A],
      door: 'record',
    });
    const codes = report.blockers.map((b) => b.code);

    expect(report.blockers[0]?.code).toBe('RELEASE_RECORD_MISSING');
    expect(codes).toContain('RELEASE_PROBES_UNREADABLE');
  });
});
