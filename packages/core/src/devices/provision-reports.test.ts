import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisionReport } from './provision-row.js';

const where = vi.fn(async (_predicate?: unknown) => undefined);
const set = vi.fn((_patch: Record<string, unknown>) => ({ where }));
const update = vi.fn((_table?: unknown) => ({ set }));

vi.mock('../db/client.js', () => ({ db: { update } }));

const { recordProvisionReports } = await import('./provision-reports.js');

const report = (over: Partial<ProvisionReport> = {}): ProvisionReport => ({
  runnerId: 'runner-1',
  projectId: 'proj-1',
  slug: 'epod-cli',
  kind: 'omitted',
  reason: 'the workspace credential for this checkout could not be minted',
  terminal: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  where.mockResolvedValue(undefined);
});

describe('recordProvisionReports', () => {
  it('writes one row\u2019s reports once, so the second does not overwrite the first', async () => {
    // A row can be short its ssh key AND unable to mint. Criterion 7 says every
    // reported failure is on the row, and a write per report leaves only the last.
    await recordProvisionReports([
      report({ kind: 'degraded', reason: 'the ssh key could not be decrypted' }),
      report({ kind: 'omitted', reason: 'the credential could not be minted', terminal: true }),
    ]);
    expect(update).toHaveBeenCalledTimes(1);
    const [patch] = set.mock.calls[0] as [Record<string, unknown>];
    expect(patch.provisionDetail).toContain('the ssh key could not be decrypted');
    expect(patch.provisionDetail).toContain('the credential could not be minted');
    // Terminal if any of them is: the row cannot succeed on the next tick either.
    expect(patch.provisionStatus).toBe('failed');
  });

  it('writes each row to its own row', async () => {
    const out = await recordProvisionReports([
      report({ runnerId: 'runner-1' }),
      report({ runnerId: 'runner-2', slug: 'portal' }),
    ]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.reason)).toEqual([
      'the workspace credential for this checkout could not be minted',
      'the workspace credential for this checkout could not be minted',
    ]);
  });

  it('takes a terminal report out of the queue, and leaves the others in it', async () => {
    await recordProvisionReports([
      report({ runnerId: 'runner-1', terminal: true }),
      report({ runnerId: 'runner-2', terminal: false }),
    ]);
    expect(set).toHaveBeenNthCalledWith(1, expect.objectContaining({ provisionStatus: 'failed' }));
    expect(set.mock.calls[1]?.[0]).not.toHaveProperty('provisionStatus');
  });

  it('never throws, so one row’s lock wait cannot cost the device its provisions', async () => {
    where.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
    await expect(
      recordProvisionReports([report({ runnerId: 'runner-1' }), report({ runnerId: 'runner-2' })]),
    ).resolves.toHaveLength(2);
    // The second row was still written: each is its own attempt.
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('says on the report itself that it could not be recorded', async () => {
    where.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
    const [out] = await recordProvisionReports([report()]);
    expect(out?.reason).toContain('the workspace credential for this checkout could not be minted');
    expect(out?.reason).toContain('not recorded on the runner row');
    expect(out?.reason).toContain('lock timeout');
  });

  it('never calls a report terminal that it could not write, since nothing left the queue', async () => {
    where.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));
    const [out] = await recordProvisionReports([report({ terminal: true })]);
    expect(out?.terminal).toBe(false);
  });
});
