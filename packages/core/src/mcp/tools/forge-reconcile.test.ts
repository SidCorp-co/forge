// Covers the `acknowledge` branch added for ISS-810. The service function itself
// is exercised in skills/reconcile-service.test.ts; what is untested elsewhere is
// the TOOL wiring — admin gate, required runId, and the cross-project IDOR
// re-check — so these mock the service out and assert only that.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const getReconcileRun = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const acknowledgeReconcileRun = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../skills/reconcile-service.js', () => ({
  getReconcileRun: (...a: unknown[]) => getReconcileRun(...a),
  acknowledgeReconcileRun: (...a: unknown[]) => acknowledgeReconcileRun(...a),
  applyReconcileRun: vi.fn(),
  listReconcileRunsForProject: vi.fn(),
  recordReconcileVerdict: vi.fn(),
  recordVerifierVote: vi.fn(),
  rejectReconcileRun: vi.fn(),
  spawnReconcileRun: vi.fn(),
}));

const assertPrincipalIsAdmin = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('./lib.js', () => ({
  assertPrincipalIsAdmin: (...a: unknown[]) => assertPrincipalIsAdmin(...a),
  assertPrincipalIsMember: vi.fn(async () => undefined),
  principalUserId: () => USER_ID,
  resolveEffectiveProjectId: async (_ctx: unknown, id?: string) => id ?? PROJECT_ID,
  zodToMcpSchema: () => ({}),
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const { forgeReconcileTool } = await import('./forge-reconcile.js');

// biome-ignore lint/suspicious/noExplicitAny: minimal ctx stand-in
const tool = forgeReconcileTool({ principal: { type: 'user', id: USER_ID } } as any);

const ack = (over: Record<string, unknown> = {}) =>
  tool.handler({ action: 'acknowledge', projectId: PROJECT_ID, runId: RUN_ID, ...over });

describe('forge_reconcile · acknowledge (ISS-810)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acknowledgeReconcileRun.mockResolvedValue(undefined);
  });

  it('acknowledges a run that belongs to the resolved project', async () => {
    getReconcileRun.mockResolvedValueOnce({ id: RUN_ID, projectId: PROJECT_ID });
    await expect(ack()).resolves.toEqual({ ok: true });
    expect(assertPrincipalIsAdmin).toHaveBeenCalledOnce();
    expect(acknowledgeReconcileRun).toHaveBeenCalledWith(RUN_ID, USER_ID, undefined);
  });

  it('forwards the optional reason', async () => {
    getReconcileRun.mockResolvedValueOnce({ id: RUN_ID, projectId: PROJECT_ID });
    await ack({ acknowledgeReason: 'handled out-of-band' });
    expect(acknowledgeReconcileRun).toHaveBeenCalledWith(RUN_ID, USER_ID, 'handled out-of-band');
  });

  it('requires runId', async () => {
    await expect(ack({ runId: undefined })).rejects.toThrow(/runId is required/);
    expect(acknowledgeReconcileRun).not.toHaveBeenCalled();
  });

  // cm:guard this is the IDOR case — runId is caller-supplied, so a run belonging to another project must NOT be mutated even when the caller is an admin of the project they named
  it('refuses a run that belongs to a different project', async () => {
    getReconcileRun.mockResolvedValueOnce({ id: RUN_ID, projectId: OTHER_PROJECT_ID });
    await expect(ack()).rejects.toThrow(/NOT_FOUND/);
    expect(acknowledgeReconcileRun).not.toHaveBeenCalled();
  });

  it('refuses an unknown run', async () => {
    getReconcileRun.mockResolvedValueOnce(undefined);
    await expect(ack()).rejects.toThrow(/NOT_FOUND/);
    expect(acknowledgeReconcileRun).not.toHaveBeenCalled();
  });

  it('surfaces the service BAD_REQUEST for a non-escalated run rather than swallowing it', async () => {
    getReconcileRun.mockResolvedValueOnce({ id: RUN_ID, projectId: PROJECT_ID });
    acknowledgeReconcileRun.mockRejectedValueOnce(
      new Error("BAD_REQUEST: run is in status 'decided' verdict 'apply', expected 'escalated'"),
    );
    await expect(ack()).rejects.toThrow(/BAD_REQUEST/);
  });
});
