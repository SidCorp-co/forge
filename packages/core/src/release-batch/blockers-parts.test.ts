/**
 * A roster over the cap, read by release readiness (ISS-1360).
 *
 * Where nobody presses release the sweep cuts the oldest 50 and queues the rest, so a readiness
 * answer of "cut this roster in parts" names an act nobody on that project takes, for ever. These
 * cases hold the one boundary that matters: the project that releases without a person acting is
 * told its part, and the project where a person cuts, or a caller who named the list, is refused.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);

const fromChain: Record<string, unknown> = {};
fromChain.where = () =>
  Object.assign(selectRows(), { limit: selectLimit, orderBy: () => selectRows() });
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

vi.mock('../issues/release-record-required.js', async (importActual) => {
  const actual = await importActual<typeof import('../issues/release-record-required.js')>();
  return { ...actual, issuesMissingReleaseRecord: async () => [] as string[] };
});

const autoRelease = vi.fn(async () => false);
vi.mock('../pipeline/auto-prod-deploy.js', () => ({
  readAutoProdDeploy: () => autoRelease(),
}));

const earned = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock('../issues/criteria-verdicts.js', async (importActual) => {
  const actual = await importActual<typeof import('../issues/criteria-verdicts.js')>();
  return { ...actual, unearnedCriteriaReports: (...a: unknown[]) => earned(...a) };
});

const closeShortfalls = vi.fn(async (..._a: unknown[]) => new Map() as Map<string, unknown[]>);
vi.mock('./close-shortfall.js', () => ({
  rosterCloseShortfalls: (...a: unknown[]) => closeShortfalls(...a),
}));

const { collectReleaseBlockers } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const SERVING = {
  kind: 'serving' as const,
  served: [{ commit: '33637c612ef15be6f924520c0d201a0889d8ed7e', where: 'https://app.test/b' }],
  unread: [],
  readAt: '2026-09-26T23:55:00.000Z',
};

const idAt = (i: number) => `id-${String(i).padStart(2, '0')}`;

/** Rows as the roster read returns them: oldest merge first, which the database does. */
function rows(waiting: number, claimed = 0) {
  return Array.from({ length: waiting }, (_, i) => ({
    id: idAt(i),
    claimed: i < claimed ? 'run-1' : null,
  }));
}

const idsOf = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => idAt(from + i));

function ready(waiting: unknown[]) {
  selectLimit.mockResolvedValue([
    {
      repoPath: '/srv/app',
      repoUrl: null,
      baseBranch: 'main',
      releaseChain: [{ branch: 'main' }],
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
        config: {
          releaseRunnerLabel: 'prod-box',
          verify: { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] },
          rollback: { mode: 'coolify-image' },
        },
        instructions: null,
        label: '',
        role: 'deploy',
        stages: ['live'],
      },
      connection: { config: {} },
    },
  ]);
  selectRows.mockResolvedValue(waiting);
  execRows.mockResolvedValue([{ device_id: 'dev-1' }]);
  onlineIds.mockResolvedValue(['dev-1']);
}

const report = async (opts: { issueIds?: string[] } = {}) =>
  await collectReleaseBlockers(PROJECT_ID, { serving: SERVING, ...opts });
const codes = (r: Awaited<ReturnType<typeof report>>) => r.blockers.map((b) => b.code);

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
  selectRows.mockResolvedValue([]);
  execRows.mockResolvedValue([]);
  onlineIds.mockResolvedValue([]);
  activeBatch.mockResolvedValue(null);
  autoRelease.mockResolvedValue(false);
  earned.mockResolvedValue([]);
  closeShortfalls.mockResolvedValue(new Map());
});

describe('a project that releases without a person acting, holding more than one release carries', () => {
  beforeEach(() => {
    autoRelease.mockResolvedValue(true);
  });

  it('is not blocked by its size, and is told the part and what is left', async () => {
    ready(rows(58));

    const r = await report();

    expect(codes(r)).not.toContain('RELEASE_ROSTER_OVERSIZE');
    expect(r.blockers).toEqual([]);
    const parted = r.warnings.find((w) => w.code === 'RELEASE_ROSTER_IN_PARTS');
    expect(parted?.details).toEqual({ waiting: 58, limit: 50, part: 50, later: 8 });
    expect(parted?.message).toContain('58 issues are waiting');
    expect(parted?.message).toContain('the 8 behind them wait for a later release');
    expect(parted?.message).toContain('Nothing here is for a person to cut');
  });

  it('judges the oldest fifty and no row behind them, in every check that reads the roster', async () => {
    ready(rows(58));

    await report();

    expect(closeShortfalls.mock.calls[0]?.[1]).toEqual(idsOf(0, 50));
    expect(earned.mock.calls[0]?.[0]).toEqual(idsOf(0, 50));
  });

  it('counts the cap against the unclaimed rows, so a running batch is not a part of its own', async () => {
    ready(rows(58, 50));
    activeBatch.mockResolvedValue({ runId: 'run-1' });

    const r = await report();

    expect(codes(r)).toEqual(['BATCH_IN_FLIGHT']);
    expect(r.warnings.map((w) => w.code)).not.toContain('RELEASE_ROSTER_IN_PARTS');
    expect(closeShortfalls.mock.calls[0]?.[1]).toEqual(idsOf(50, 58));
    expect(earned.mock.calls[0]?.[0]).toEqual(idsOf(50, 58));
  });

  it('says nothing about parts at exactly fifty unclaimed rows beside a claimed one', async () => {
    ready(rows(51, 1));

    const r = await report();

    expect(codes(r)).not.toContain('RELEASE_ROSTER_OVERSIZE');
    expect(r.warnings.map((w) => w.code)).not.toContain('RELEASE_ROSTER_IN_PARTS');
    expect(closeShortfalls.mock.calls[0]?.[1]).toEqual(idsOf(1, 51));
  });

  it('puts the next row, alone, behind a full part at fifty-one', async () => {
    ready(rows(51));

    const parted = (await report()).warnings.find((w) => w.code === 'RELEASE_ROSTER_IN_PARTS');

    expect(parted?.details).toEqual({ waiting: 51, limit: 50, part: 50, later: 1 });
    expect(parted?.message).toContain('the 1 behind it');
  });

  it('keeps the size refusal where it cannot read whether a person cuts, and names the read it could not take', async () => {
    ready(rows(58));
    autoRelease.mockRejectedValue(new Error('projects table unreadable'));

    const r = await report();

    expect(codes(r)).toEqual(expect.arrayContaining(['RELEASE_ROSTER_OVERSIZE']));
    const unread = r.blockers.find(
      (b) => b.code === 'RELEASE_CHECK_UNEVALUATED' && b.details?.check === 'auto-release',
    );
    expect(unread).toBeDefined();
  });

  it('still refuses a list of fifty-one issues the caller named', async () => {
    ready(rows(1));
    const named = Array.from({ length: 51 }, (_, i) => `named-${i}`);

    const r = await report({ issueIds: named });

    const over = r.blockers.find((b) => b.code === 'RELEASE_ROSTER_OVERSIZE');
    expect(over?.details).toEqual({ waiting: 51, limit: 50 });
    expect(over?.scope).toBe('roster');
  });
});

describe('a project where a person cuts the release, holding more than one release carries', () => {
  it('is still refused by size, with the remedy it always had', async () => {
    ready(rows(58));

    const r = await report();

    const over = r.blockers.find((b) => b.code === 'RELEASE_ROSTER_OVERSIZE');
    expect(over?.details).toEqual({ waiting: 58, limit: 50 });
    expect(over?.message).toBe(
      '58 waiting. More issues are waiting than one release may carry. A release names at most 50 issues, so cut this roster in parts, oldest merge first.',
    );
    expect(r.warnings.map((w) => w.code)).not.toContain('RELEASE_ROSTER_IN_PARTS');
  });
});
