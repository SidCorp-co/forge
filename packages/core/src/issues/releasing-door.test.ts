/**
 * ISS-1421 — the door onto and off `releasing`, measured on its own. The integration suites
 * (`releasing-door-e2e`, `releasing-settle-e2e`) prove every route reaches it; this proves what it
 * answers for each ask, and that each refusal says what Releasing is and where a release starts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimRow = vi.fn(async () => [{ run: null as string | null }]);
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => claimRow() }) }) }),
  },
}));

const declaration = vi.fn(async (): Promise<{ kind: string } | null> => ({ kind: 'gated' }));
vi.mock('../release-batch/gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../release-batch/gate.js')>()),
  resolveReleaseDeclaration: () => declaration(),
}));

const { releasingDoorRefusal } = await import('./releasing-door.js');

const base = { issueId: 'iss-1', projectId: 'proj-7' } as const;

beforeEach(() => {
  claimRow.mockReset();
  claimRow.mockResolvedValue([{ run: null }]);
  declaration.mockReset();
  declaration.mockResolvedValue({ kind: 'gated' });
});

describe('entering releasing (ISS-1421)', () => {
  it('refuses every door that names no release run, saying where a release starts', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain(
      'Releasing (releasing) means a release batch is carrying this issue to production right now',
    );
    expect(refusal?.detail).toContain("Release now on this issue's page");
    expect(refusal?.detail).toContain('at the release gate');
    expect(refusal?.detail).toContain('POST /api/projects/proj-7/release-batches');
    expect(refusal?.detail).toContain('The issue stays at Awaiting release (awaiting_release).');
  });

  it('tells an issue not yet at the gate it must reach Awaiting release first, not to press Release now', async () => {
    for (const from of ['open', 'developed', 'testing'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from, to: 'releasing' });
      expect(refusal?.code, from).toBe('RELEASING_STARTS_FROM_RELEASE');
      expect(refusal?.detail, from).toContain(
        'so it must reach Awaiting release (awaiting_release) before a release can carry it',
      );
      expect(refusal?.detail, from).not.toContain('Release now');
      expect(refusal?.detail, from).not.toContain('release-batches');
    }
  });

  it('on a project that ships nothing, names the setting and no release door', async () => {
    declaration.mockResolvedValue({ kind: 'no-release' });
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain('This project ships nothing');
    expect(refusal?.detail).toContain('Shape & release setting chooses a shape that releases');
    expect(refusal?.detail).not.toContain('Release now');
    expect(refusal?.detail).not.toContain('release gate');
    expect(refusal?.detail).not.toContain('release-batches');
  });

  it('on a project with no live deploy target, says no release can start until one is added', async () => {
    declaration.mockResolvedValue({ kind: 'undeclared-target' });
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.detail).toContain(
      'no release can start until one is added on its integrations screen',
    );
    expect(refusal?.detail).not.toContain('Release now');
    expect(refusal?.detail).not.toContain('release gate');
  });

  it('names no door where the declaration cannot be read', async () => {
    declaration.mockRejectedValue(new Error('db down'));
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
    expect(refusal?.detail).toContain('could not be read, so no door is named here');
    expect(refusal?.detail).not.toContain('Release now');
  });

  it('refuses it from any rung, not only the gate', async () => {
    for (const from of ['open', 'in_progress', 'testing', 'on_hold', 'closed'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from, to: 'releasing' });
      expect(refusal?.code, from).toBe('RELEASING_STARTS_FROM_RELEASE');
    }
  });

  it('refuses a release path flag that names no run: viaReleasePath does not open the entry', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
      viaReleasePath: true,
    });
    expect(refusal?.code).toBe('RELEASING_STARTS_FROM_RELEASE');
  });

  it('lets the batch create through, naming its run', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'awaiting_release',
      to: 'releasing',
      releaseRun: 'run-1',
    });
    expect(refusal).toBeNull();
  });

  it('throws on a run named for a move that does not enter releasing', async () => {
    await expect(
      releasingDoorRefusal({
        ...base,
        from: 'testing',
        to: 'awaiting_release',
        releaseRun: 'run-1',
      }),
    ).rejects.toThrow(/releaseRun names the run a move ENTERS Releasing \(releasing\)/);
  });
});

describe('leaving releasing (ISS-1421)', () => {
  it('refuses a move off it from a door that is not a release path, naming the claiming run', async () => {
    claimRow.mockResolvedValue([{ run: 'run-9' }]);
    for (const to of ['closed', 'reopen', 'needs_info', 'on_hold', 'awaiting_release'] as const) {
      const refusal = await releasingDoorRefusal({ ...base, from: 'releasing', to });
      expect(refusal?.code, to).toBe('RELEASING_ENDS_BY_RELEASE');
      expect(refusal?.detail).toContain('GET /api/projects/proj-7/release-batches/run-9/state');
      expect(refusal?.detail).toContain('POST /api/projects/proj-7/release-batches/run-9/abort');
      expect(refusal?.detail).toContain('The issue stays at Releasing (releasing)');
    }
  });

  it('says an unclaimed row is settled by the sweep rather than offering an abort', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'releasing',
      to: 'awaiting_release',
    });
    expect(refusal?.detail).toContain('the releasing sweep returns it to the release gate');
    expect(refusal?.detail).not.toContain('/abort');
  });

  it('lets a release path through', async () => {
    const refusal = await releasingDoorRefusal({
      ...base,
      from: 'releasing',
      to: 'closed',
      viaReleasePath: true,
    });
    expect(refusal).toBeNull();
  });

  it('answers nothing for a move that touches releasing on neither side', async () => {
    expect(
      await releasingDoorRefusal({ ...base, from: 'testing', to: 'awaiting_release' }),
    ).toBeNull();
    expect(claimRow).not.toHaveBeenCalled();
  });
});
