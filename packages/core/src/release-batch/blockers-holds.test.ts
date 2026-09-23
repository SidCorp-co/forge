/**
 * The two reasons that read their own details rather than a literal: what the
 * fleet is actually held by, and what the unattended sweep will not carry.
 *
 * Split from `blockers.test.ts`, which is about WHICH reasons a report holds.
 * These are about what each one then says, which is where ISS-1127's Outcome
 * failed while every code and every ordering was right.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerHold } from '../runners/ineligible.js';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);
/** The joined read behind `issueDisplayIds`, which names a held issue as a screen does. */
const joinRows = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Object.assign(selectRows(), { limit: selectLimit }),
        innerJoin: () => ({ where: () => joinRows() }),
      }),
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

const runnerHolds = vi.fn(async () => [] as unknown[]);
vi.mock('../runners/ineligible.js', async (importActual) => {
  const actual = await importActual<typeof import('../runners/ineligible.js')>();
  return { ...actual, releaseIneligibleRunners: () => runnerHolds() };
});

const autoRelease = vi.fn(async () => false);
vi.mock('../pipeline/auto-prod-deploy.js', () => ({
  projectAutoProdDeploy: () => autoRelease(),
}));

const unearned = vi.fn(async () => [] as unknown[]);
vi.mock('../issues/criteria-verdicts.js', async (importActual) => {
  const actual = await importActual<typeof import('../issues/criteria-verdicts.js')>();
  return { ...actual, unearnedCriteriaReports: () => unearned() };
});

const { collectReleaseBlockers } = await import('./blockers.js');
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
  joinRows.mockResolvedValue([]);
  selectRows.mockResolvedValue([]);
  execRows.mockResolvedValue([]);
  onlineIds.mockResolvedValue([]);
  activeBatch.mockResolvedValue(null);
  missingNotes.mockResolvedValue([]);
  runnerHolds.mockResolvedValue([]);
  autoRelease.mockResolvedValue(false);
  unearned.mockResolvedValue([]);
});

/**
 * One box registered, reporting, and taken out of the pool by an operator.
 * Typed, because an untyped literal here let `name` survive a rename that the
 * compiler would otherwise have caught (ISS-1127, criterion 17).
 */
const RETIRED: RunnerHold = {
  deviceName: 'dev1',
  reason: 'retired',
  detail: 'draining',
  lastSeenSeconds: 13,
  reporting: true,
};

const heldReport = (issueId: string, criteria: number[]) => ({
  issueId,
  unearned: criteria.map((criterion) => ({
    criterion,
    verdict: null,
    standing: null,
    why: 'no verdict was recorded for it',
  })),
  broken: [],
});

describe('what NO_RUNNER_ONLINE says about the fleet', () => {
  it('carries the reading for each box rather than a sentence about bringing one up', async () => {
    ready();
    onlineIds.mockResolvedValue([]);
    runnerHolds.mockResolvedValue([RETIRED]);

    const report = await collectReleaseBlockers(PROJECT_ID);
    const held = report.blockers.find((b) => b.code === 'NO_RUNNER_ONLINE');

    expect(held?.details?.runners).toEqual([RETIRED]);
    expect(held?.message).toContain('dev1');
    expect(held?.message).toContain('Takes jobs from the pool');
  });

  // The file's own promise: a reason that cannot be READ is not the same as a
  // reason that is absent, so a failed per-box read must not take the reason
  // the operator can act on with it.
  it('keeps the reason standing when the per-box read itself fails', async () => {
    ready();
    onlineIds.mockResolvedValue([]);
    runnerHolds.mockRejectedValue(new Error('runners table unreadable'));

    const codes = (await collectReleaseBlockers(PROJECT_ID)).blockers.map((b) => b.code);

    expect(codes).toContain('NO_RUNNER_ONLINE');
    expect(codes).toContain('RELEASE_CHECK_UNEVALUATED');
  });

  it('does not read the fleet at all where a box is eligible', async () => {
    ready();

    await collectReleaseBlockers(PROJECT_ID);

    expect(runnerHolds).not.toHaveBeenCalled();
  });
});

describe('the hold the unattended sweep puts on a waiting issue', () => {
  it('blocks the roster question where every waiting issue is held', async () => {
    ready();
    autoRelease.mockResolvedValue(true);
    unearned.mockResolvedValue([heldReport(ISSUE_A, [3, 7])]);

    joinRows.mockResolvedValue([{ id: ISSUE_A, issSeq: 1127, issuePrefix: 'ISS' }]);

    const report = await collectReleaseBlockers(PROJECT_ID);
    const held = report.blockers.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');

    expect(held?.scope).toBe('roster');
    expect(held?.message).toContain('`ISS-1127` owes criterion 3, 7');
    expect(held?.message).not.toContain(ISSUE_A);
    expect(held?.details?.held).toEqual([
      { issueId: ISSUE_A, displayId: 'ISS-1127', criteria: [3, 7] },
    ]);
  });

  // The create door answers about the list it was given, and does not read
  // criteria — so this reason must never reach it or the two doors disagree.
  it('never reaches a caller that named its own list', async () => {
    ready();
    autoRelease.mockResolvedValue(true);
    unearned.mockResolvedValue([heldReport(ISSUE_A, [3])]);

    const report = await collectReleaseBlockers(PROJECT_ID, {
      issueIds: [ISSUE_A],
      door: 'batch',
    });

    expect(report.blockers.map((b) => b.code)).not.toContain('RELEASE_CRITERIA_UNEARNED');
  });

  it('says nothing where a person cuts this project\u2019s releases by hand', async () => {
    ready();
    unearned.mockResolvedValue([heldReport(ISSUE_A, [3])]);

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers.map((b) => b.code)).not.toContain('RELEASE_CRITERIA_UNEARNED');
    expect(unearned).not.toHaveBeenCalled();
  });

  it('warns instead of blocking where a release still starts without them', async () => {
    projectRow();
    liveBinding(DECLARED);
    selectRows.mockResolvedValue([
      { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: new Date() },
      { id: ISSUE_B, status: 'awaiting_release', claimed: null, mergedAt: new Date() },
    ]);
    execRows.mockResolvedValue([{ device_id: 'dev-1' }]);
    onlineIds.mockResolvedValue(['dev-1']);
    autoRelease.mockResolvedValue(true);
    unearned.mockResolvedValue([
      heldReport(ISSUE_A, [1]),
      { issueId: ISSUE_B, unearned: [], broken: [] },
    ]);

    joinRows.mockResolvedValue([{ id: ISSUE_A, issSeq: 1142, issuePrefix: 'ISS' }]);

    const report = await collectReleaseBlockers(PROJECT_ID);

    expect(report.blockers.map((b) => b.code)).not.toContain('RELEASE_CRITERIA_UNEARNED');
    const warned = report.warnings.find((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK');
    expect(warned?.message).toContain('A release will still be cut');
    expect(warned?.message).toContain('`ISS-1142` owes criterion 1');
    expect(warned?.message).not.toContain(ISSUE_A);
  });

  it('leaves the uuid standing where the name read came back without that row', async () => {
    ready();
    autoRelease.mockResolvedValue(true);
    unearned.mockResolvedValue([heldReport(ISSUE_A, [2])]);
    joinRows.mockResolvedValue([]);

    const report = await collectReleaseBlockers(PROJECT_ID);
    const held = report.blockers.find((b) => b.code === 'RELEASE_CRITERIA_UNEARNED');

    expect(held?.message).toContain(`\`${ISSUE_A}\` owes criterion 2`);
  });
});
