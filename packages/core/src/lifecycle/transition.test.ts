import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard `applyKernelTransition` is the only reliable hook point for every session-terminal writer EXCEPT the runner's own `PATCH /:id` happy path, which is a direct `db.update` wired separately in `agent-sessions/routes.ts`. Anything hung here — the ISS-675 escalation bridge, the ISS-927 token revoke — needs its second half there, and this suite covers only the half that lives here.

const deliverEscalationReplyOnce = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../integrations/rocketchat/escalation-bridge.js', () => ({
  deliverEscalationReplyOnce: (...args: unknown[]) => deliverEscalationReplyOnce(...args),
}));

const { applyKernelTransition } = await import('./transition.js');

const auditValues = vi.fn(async (..._args: unknown[]) => undefined);

function makeExec(returningRows: unknown[]) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => returningRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: (...args: unknown[]) => auditValues(...args) })),
  } as never;
}

/** The single `kernel_transitions` row this call wrote. */
function auditedRow(): Record<string, unknown> {
  const rows = auditValues.mock.calls[0]?.[0] as Record<string, unknown>[];
  return rows?.[0] ?? {};
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

/**
 * ISS-927 — `actor_agency` is the second actor axis on the audit row, and it is
 * not a refinement of `actor_type`. `actor_type` says who OWNS the write, which
 * for a job or session token is truthfully its creator; `actor_agency` says who
 * was at the keyboard. They disagree for exactly the rows the ISS-786/812
 * evidence gates exist to catch.
 */
describe('applyKernelTransition — the agency written on the audit row', () => {
  beforeEach(() => {
    auditValues.mockClear();
  });

  // cm:guard the value must come from the CALLER, never from `actor.type`. A `user` actor is the only kind that can be either, because that is the shape a job or session token transitions under — read it off the type and every agent write in the system records `human`, which is the default the column already had and the reason it needed a writer at all.
  it.each([
    ['a person at the keyboard', 'human' as const],
    ['a job or session token', 'agent' as const],
  ])('records %s as %s', async (_label, agency) => {
    const exec = makeExec([{ id: 'job-1' }]);

    await applyKernelTransition(exec, {
      entity: 'job',
      to: 'cancelled',
      where: undefined,
      actor: { type: 'user', id: 'u1', agency },
      source: 'test',
    });

    expect(auditedRow()).toMatchObject({ actorType: 'user', actorAgency: agency });
  });

  // cm:guard `system`, `sweeper` and `runner` carry NO `agency` field — the type is a machine by construction and the union refuses one, so there is no call site able to record a sweeper as a person. If this ever reads `'human'`, the union has been flattened back to an optional field and the compiler has stopped naming omissions.
  it.each([['system' as const], ['sweeper' as const], ['runner' as const]])(
    'records a %s actor as an agent without being told',
    async (type) => {
      const exec = makeExec([{ id: 'job-1' }]);

      await applyKernelTransition(exec, {
        entity: 'job',
        to: 'failed',
        where: undefined,
        actor: { type },
        source: 'test',
      });

      expect(auditedRow()).toMatchObject({ actorType: type, actorAgency: 'agent' });
    },
  );
});
