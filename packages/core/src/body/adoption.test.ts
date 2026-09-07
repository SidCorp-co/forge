/**
 * The number, and the two ways a number like this is usually wrong.
 *
 * It can count what was INTENDED — a body that mentions `forge-outcome` in a
 * sentence — and it can count the wrong POPULATION, folding people's prose into
 * a denominator for a rule that never applies to them. Both read exactly like a
 * correct figure from the outside, so both are planted here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { stage: string | null; format: string; template: string | null; n: number };

const groupedRows = vi.fn(async (): Promise<Row[]> => []);
const projectRow = vi.fn(
  async (): Promise<Array<{ agentConfig: unknown }>> => [{ agentConfig: null }],
);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ groupBy: () => groupedRows() }),
        }),
        where: () => ({ limit: () => projectRow() }),
      }),
    })),
  },
}));

const { readBodyAdoption, ADOPTION_DEFAULT_WINDOW_DAYS } = await import('./adoption.js');

beforeEach(() => {
  vi.clearAllMocks();
  projectRow.mockResolvedValue([{ agentConfig: null }]);
});

describe('readBodyAdoption', () => {
  it('answers one row per stage name, even for stages nothing was written at', async () => {
    const report = await readBodyAdoption('proj-1');
    expect(report.stages.map((s) => s.stage)).toEqual([
      'open',
      'in_progress',
      'needs_info',
      'released',
    ]);
    expect(report.windowDays).toBe(ADOPTION_DEFAULT_WINDOW_DAYS);
  });

  it('counts a stored component under the stage it was written at', async () => {
    groupedRows.mockResolvedValueOnce([
      { stage: 'open', format: 'html', template: 'forge-outcome', n: 3 },
      { stage: 'open', format: 'markdown', template: null, n: 7 },
      { stage: 'released', format: 'html', template: 'forge-close', n: 1 },
    ]);
    const report = await readBodyAdoption('proj-1');
    const open = report.stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(10);
    expect(open?.byComponent).toEqual({ 'forge-outcome': 3 });
    expect(report.stages.find((s) => s.stage === 'released')?.byComponent).toEqual({
      'forge-close': 1,
    });
  });

  // cm:guard this is the "counts what is stored, not what was intended" rule made falsifiable. A markdown row cannot hold a template today; the assertion is what keeps the number from ever being derived from body text instead.
  it('counts nothing for a markdown row, whatever its template column says', async () => {
    groupedRows.mockResolvedValueOnce([
      { stage: 'open', format: 'markdown', template: 'forge-outcome', n: 5 },
    ]);
    const report = await readBodyAdoption('proj-1');
    const open = report.stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(5);
    expect(open?.byComponent).toEqual({});
  });

  it('reports no required component until a project declares one', async () => {
    groupedRows.mockResolvedValueOnce([
      { stage: 'open', format: 'html', template: 'forge-outcome', n: 2 },
    ]);
    const open = (await readBodyAdoption('proj-1')).stages.find((s) => s.stage === 'open');
    expect(open?.requireComponent).toBeNull();
    expect(open?.carryingRequired).toBeNull();
    expect(open?.fractionRequired).toBeNull();
  });

  it('reports the fraction carrying what the stage requires, once it requires one', async () => {
    projectRow.mockResolvedValue([
      {
        agentConfig: {
          pipelineConfig: {
            states: { open: { bodyPolicy: { requireComponent: 'forge-outcome' } } },
          },
        },
      },
    ]);
    groupedRows.mockResolvedValueOnce([
      { stage: 'open', format: 'html', template: 'forge-outcome', n: 3 },
      { stage: 'open', format: 'markdown', template: null, n: 1 },
    ]);
    const open = (await readBodyAdoption('proj-1')).stages.find((s) => s.stage === 'open');
    expect(open?.requireComponent).toBe('forge-outcome');
    expect(open?.carryingRequired).toBe(3);
    expect(open?.fractionRequired).toBeCloseTo(0.75);
  });

  it('reports a zero fraction rather than dividing by nothing at a silent stage', async () => {
    projectRow.mockResolvedValue([
      {
        agentConfig: {
          pipelineConfig: {
            states: { open: { bodyPolicy: { requireComponent: 'forge-outcome' } } },
          },
        },
      },
    ]);
    const open = (await readBodyAdoption('proj-1')).stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(0);
    expect(open?.carryingRequired).toBe(0);
    expect(open?.fractionRequired).toBeNull();
  });

  it('walks the window back from now by the days asked for', async () => {
    const report = await readBodyAdoption('proj-1', 7);
    const days = (Date.now() - Date.parse(report.since)) / 86_400_000;
    expect(days).toBeCloseTo(7, 2);
    expect(report.windowDays).toBe(7);
  });
});
