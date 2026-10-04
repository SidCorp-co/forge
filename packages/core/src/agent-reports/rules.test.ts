import { describe, expect, it } from 'vitest';
import { promotedRefusals } from './rules.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('a promoted agent report keeps its route (ISS-93)', () => {
  it('un-reviewing a promoted report is AGENT_REPORT_PROMOTED naming the item it became', () => {
    const [r] = promotedRefusals([{ id: A, seq: 7 }], false);
    expect(r).toMatchObject({ code: 'AGENT_REPORT_PROMOTED', path: '/reviewed' });
    expect(r?.detail).toContain('FB-7');
    expect(r?.detail).toContain(A);
  });

  it('curating a promoted report into an issue is refused the same way, at linkedIssueId', () => {
    const [r] = promotedRefusals([{ id: A, seq: 7 }], true);
    expect(r).toMatchObject({ code: 'AGENT_REPORT_PROMOTED', path: '/linkedIssueId' });
    expect(r?.detail).toContain('triage FB-7');
  });

  it('names every promoted report of a bulk review, and refuses nothing when none is promoted', () => {
    expect(
      promotedRefusals(
        [
          { id: A, seq: 7 },
          { id: B, seq: 9 },
        ],
        false,
      ),
    ).toHaveLength(2);
    expect(promotedRefusals([], false)).toEqual([]);
  });
});
