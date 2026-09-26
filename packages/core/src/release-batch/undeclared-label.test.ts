/**
 * A project that names no release runner is refused nothing.
 *
 * ISS-1275 — anhome held thirty issues at the release gate for seven hours
 * behind `RELEASE_RUNNER_UNDECLARED`, a refusal whose own sentence ended "so a
 * project with one box may name anything". Each door is asked on its own here,
 * because each composes its own list and one of them going quiet says nothing
 * about the other.
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

const { collectReleaseBlockers } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const ISSUE_A = '77777777-7777-4777-8777-777777777777';
const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };

/** Everything a release needs, and no `releaseRunnerLabel` on either side. */
function unlabelled() {
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
    },
  ]);
  listBindings.mockResolvedValue([
    {
      binding: {
        id: 'b-1',
        provider: 'coolify',
        config: { verify: PROBES, rollback: { mode: 'coolify-image' } },
        instructions: null,
        label: '',
        role: 'deploy',
        stages: ['live'],
      },
      connection: { config: {} },
    },
  ]);
  selectRows.mockResolvedValue([
    { id: ISSUE_A, status: 'awaiting_release', claimed: null, mergedAt: new Date() },
  ]);
  execRows.mockResolvedValue([{ device_id: 'dev-1' }]);
  onlineIds.mockResolvedValue(['dev-1']);
}

beforeEach(() => {
  vi.clearAllMocks();
  missingNotes.mockResolvedValue([]);
  activeBatch.mockResolvedValue(null);
  unlabelled();
});

describe('a project that declares no release runner label', () => {
  it('is refused nothing at the batch door', async () => {
    expect((await collectReleaseBlockers(PROJECT_ID)).blockers).toEqual([]);
  });

  it('is refused nothing at the record door', async () => {
    const report = await collectReleaseBlockers(PROJECT_ID, {
      issueIds: [ISSUE_A],
      door: 'record',
    });

    expect(report.blockers).toEqual([]);
  });
});
