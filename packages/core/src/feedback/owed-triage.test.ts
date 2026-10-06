import { describe, expect, it } from 'vitest';
import { bySeverity } from './owed-triage.js';

describe('the owed list is ordered by severity, which admits nothing', () => {
  it('puts the most severe first and keeps filing order within one severity', () => {
    const filed = [
      { key: 'FB-1', severity: 'low' },
      { key: 'FB-2', severity: 'critical' },
      { key: 'FB-3', severity: 'medium' },
      { key: 'FB-4', severity: 'low' },
      { key: 'FB-5', severity: 'high' },
      { key: 'FB-6', severity: 'critical' },
    ] as const;
    expect(bySeverity(filed).map((r) => r.key)).toEqual([
      'FB-2',
      'FB-6',
      'FB-5',
      'FB-3',
      'FB-1',
      'FB-4',
    ]);
  });

  it('drops no row, whatever its severity', () => {
    const filed = [{ severity: 'low' }, { severity: 'medium' }] as const;
    expect(bySeverity(filed)).toHaveLength(2);
  });
});
