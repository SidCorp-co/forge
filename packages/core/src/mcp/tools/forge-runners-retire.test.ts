/**
 * Retiring a runner leaves a trace of who retired it.
 *
 * `restore` wrote `runners.status` through the audited setter and `retire`, one
 * action above it in the same file, wrote it through the unaudited one — so the
 * two states an operator is told to fix, `draining` and `disabled`, were the two
 * with no provenance. A box read `disabled` at production with no `runner_events`
 * row behind it while a release blocker said an operator had put it there
 * (ISS-1127).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const audited = vi.fn(async () => ({ found: true, changed: true, oldStatus: 'online' }));
vi.mock('../../runners/runner-events.js', () => ({ setRunnerStatus: audited }));

const findRunnerProjectId = vi.fn(async () => 'p-1' as string | null);
const findRunnerById = vi.fn(async () => ({
  id: 'r-1',
  projectId: 'p-1',
  type: 'claude-code',
  deviceId: 'd-1',
  name: 'box',
  status: 'disabled',
  labels: [],
  capabilities: {},
  config: {},
}));
vi.mock('../../runners/service.js', () => ({
  findRunnerById: () => findRunnerById(),
  findRunnerProjectId: () => findRunnerProjectId(),
  insertRunner: vi.fn(),
  listRunners: vi.fn(),
  RunnerAlreadyBoundError: class extends Error {},
  setRunnerCapabilities: vi.fn(),
}));

const inFlight = vi.fn(async () => 0);
vi.mock('../../jobs/in-flight.js', () => ({
  countInFlightByRunner: vi.fn(async () => new Map()),
  countInFlightForOneRunner: () => inFlight(),
}));

vi.mock('./lib.js', async (importActual) => {
  const actual = await importActual<typeof import('./lib.js')>();
  return { ...actual, assertPrincipalIsAdmin: vi.fn(async () => undefined) };
});

const { forgeRunnersTool } = await import('./forge-runners.js');

const RUNNER = '11111111-1111-4111-8111-111111111111';

function retire(over: Record<string, unknown> = {}) {
  const tool = forgeRunnersTool({ principal: { kind: 'user', userId: 'u-1' } } as never);
  return tool.handler({ action: 'retire', runnerId: RUNNER, ...over } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  audited.mockResolvedValue({ found: true, changed: true, oldStatus: 'online' });
  findRunnerProjectId.mockResolvedValue('p-1');
  inFlight.mockResolvedValue(0);
});

describe('forge_runners action=retire', () => {
  it('writes `disabled` through the setter that records the transition', async () => {
    await retire();

    expect(audited).toHaveBeenCalledWith({
      runnerId: RUNNER,
      newStatus: 'disabled',
      reason: 'mcp_retire',
    });
  });

  it('records the `draining` step too where a busy box is forced out', async () => {
    inFlight.mockResolvedValue(2);

    await retire({ force: true });

    expect(audited).toHaveBeenNthCalledWith(1, {
      runnerId: RUNNER,
      newStatus: 'draining',
      reason: 'mcp_retire',
    });
    expect(audited).toHaveBeenNthCalledWith(2, {
      runnerId: RUNNER,
      newStatus: 'disabled',
      reason: 'mcp_retire',
    });
  });

  it('refuses a busy box rather than retiring it unforced, so nothing is recorded', async () => {
    inFlight.mockResolvedValue(1);

    await expect(retire()).rejects.toThrow('RUNNER_BUSY');
    expect(audited).not.toHaveBeenCalled();
  });

  it('says the runner is gone where the setter found no row', async () => {
    audited.mockResolvedValue({ found: false, changed: false, oldStatus: null } as never);

    await expect(retire()).rejects.toThrow('NOT_FOUND');
  });
});
