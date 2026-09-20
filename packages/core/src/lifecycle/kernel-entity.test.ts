import { describe, expect, it, vi } from 'vitest';
import { applyKernelTransition, type KernelEntity } from './transition.js';

/**
 * ISS-1107 — `issues` is audited by the same table as the three kernel entities
 * but is NOT driven by this chokepoint: its writer carries a compare-and-set on
 * the prior status and columns no row type here has.
 *
 * The table pick used to be a ternary chain, whose last arm is `pipeline_runs`.
 * A fourth entity reaching it would have UPDATEd the wrong table and returned
 * rows as though it had worked. This is the case that fails without the
 * refusal.
 */
function stubExecutor(): {
  exec: Parameters<typeof applyKernelTransition>[0];
  update: ReturnType<typeof vi.fn>;
  stamp: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn();
  const stamp = vi.fn(async () => undefined);
  const tx = {
    execute: stamp,
    update,
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  const exec = {
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as Parameters<typeof applyKernelTransition>[0];
  return { exec, update, stamp };
}

describe('applyKernelTransition — an entity it does not drive', () => {
  it('refuses `issue` by name instead of writing to pipeline_runs', async () => {
    const { exec, update } = stubExecutor();

    await expect(
      applyKernelTransition(exec, {
        entity: 'issue' as KernelEntity as 'run',
        to: 'completed',
        where: undefined,
        actor: { type: 'system' },
        source: 'test',
      }),
    ).rejects.toThrow(/has no table for `issue`/);

    expect(update).not.toHaveBeenCalled();
  });

  it('names where an issue status write does belong', async () => {
    const { exec } = stubExecutor();

    await expect(
      applyKernelTransition(exec, {
        entity: 'issue' as KernelEntity as 'run',
        to: 'completed',
        where: undefined,
        actor: { type: 'system' },
        source: 'test',
      }),
    ).rejects.toThrow(/issues\/apply-transition\.ts:transitionIssueStatus/);
  });

  it('refuses before it stamps, so a refused call leaves the transaction unmarked', async () => {
    const { exec, stamp } = stubExecutor();

    await expect(
      applyKernelTransition(exec, {
        entity: 'issue' as KernelEntity as 'run',
        to: 'completed',
        where: undefined,
        actor: { type: 'system' },
        source: 'test',
      }),
    ).rejects.toThrow();

    expect(stamp).not.toHaveBeenCalled();
  });

  it.each(['job', 'session', 'run'] as const)('still drives `%s`', async (entity) => {
    const { exec, update } = stubExecutor();
    update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    });

    await applyKernelTransition(exec, {
      entity,
      to: entity === 'job' ? 'done' : 'completed',
      where: undefined,
      actor: { type: 'system' },
      source: 'test',
    } as Parameters<typeof applyKernelTransition>[1]);

    expect(update).toHaveBeenCalledOnce();
  });
});
