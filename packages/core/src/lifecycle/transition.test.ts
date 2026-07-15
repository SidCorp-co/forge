import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-675 — `applyKernelTransition` is the ONLY reliable hook point for every
// session-terminal writer except the runner's own PATCH /:id happy path (see
// agent-sessions/routes.ts, wired separately). This suite asserts the
// escalation completion bridge fires from here, narrowly gated on the
// `metadata.escalation` marker so ordinary (non-escalation) transitions never
// pay for it.

const deliverEscalationReplyOnce = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../integrations/rocketchat/escalation-bridge.js', () => ({
  deliverEscalationReplyOnce: (...args: unknown[]) => deliverEscalationReplyOnce(...args),
}));

const { applyKernelTransition } = await import('./transition.js');

function makeExec(returningRows: unknown[]) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => returningRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  } as never;
}

describe('applyKernelTransition — ISS-675 escalation bridge hook', () => {
  beforeEach(() => {
    deliverEscalationReplyOnce.mockClear();
  });

  it('fires the bridge for a session row carrying metadata.escalation', async () => {
    const row = { id: 'session-1', metadata: { escalation: { rid: 'room-1' } } };
    const exec = makeExec([row]);

    await applyKernelTransition(exec, {
      entity: 'session',
      to: 'failed',
      where: undefined,
      actor: { type: 'system' },
      source: 'test',
    });

    await vi.waitFor(() => expect(deliverEscalationReplyOnce).toHaveBeenCalledWith(row));
  });

  it('does not fire the bridge for an ordinary session with no escalation metadata', async () => {
    const row = { id: 'session-2', metadata: { lensOverride: ['product'] } };
    const exec = makeExec([row]);

    await applyKernelTransition(exec, {
      entity: 'session',
      to: 'completed',
      where: undefined,
      actor: { type: 'system' },
      source: 'test',
    });

    // Give any (incorrect) fire-and-forget call a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliverEscalationReplyOnce).not.toHaveBeenCalled();
  });

  it('does not fire the bridge for a job/run transition', async () => {
    const row = { id: 'job-1' };
    const exec = makeExec([row]);

    await applyKernelTransition(exec, {
      entity: 'job',
      to: 'done',
      where: undefined,
      actor: { type: 'system' },
      source: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliverEscalationReplyOnce).not.toHaveBeenCalled();
  });

  it('does not fire the bridge when the CAS matched no rows', async () => {
    const exec = makeExec([]);

    await applyKernelTransition(exec, {
      entity: 'session',
      to: 'failed',
      where: undefined,
      actor: { type: 'system' },
      source: 'test',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliverEscalationReplyOnce).not.toHaveBeenCalled();
  });
});
