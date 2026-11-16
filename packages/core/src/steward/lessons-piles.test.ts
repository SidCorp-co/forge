// ISS-1251 §5: a pile past its cap raises one consolidation item where it is owned, and a Tier-0 map
// raises none: it carries the most used cards within its cap and reaches the rest through forge_find.

import type { PileRow } from '@forge/contracts/door-use';
import { describe, expect, it, vi } from 'vitest';

const debts = vi.fn(async (_debt: unknown) => true);
const feedback = vi.fn(async (_filed: unknown) => ({
  ok: true as const,
  homeId: 'home',
  id: 'fb',
  created: true,
}));
vi.mock('../cleanup/index.js', () => ({ recordForgeDebt: debts }));
vi.mock('../feedback/index.js', () => ({ fileForgeFeedback: feedback }));
vi.mock('../projects/index.js', () => ({
  findProjectSlugs: async (ids: string[]) => new Map(ids.map((id) => [id, 'ward'])),
}));

const { provideStewardPorts } = await import('./ports.js');
const { openPileConsolidations } = await import('./lessons-piles.js');

const pile = (row: Partial<PileRow> & Pick<PileRow, 'pile' | 'name'>): PileRow => ({
  size: 3000,
  cap: 2500,
  items: 60,
  carried: 15,
  over: true,
  ...row,
});

describe('a pile past its cap opens its item where it is owned', () => {
  it('opens a debt for the always-on knowledge, feedback for a skill, and nothing for a Tier-0 map', async () => {
    provideStewardPorts({
      piles: async (projectId: string) => ({
        projectId,
        piles: [
          pile({ pile: 'always_knowledge', name: 'always-on knowledge', cap: 6000, size: 7000 }),
          pile({ pile: 'lessons_map', name: 'lessons map (runs)', over: false }),
          pile({ pile: 'tier0_map', name: 'map (master)' }),
          pile({ pile: 'skill_always_on', name: 'forge-master', cap: 1024, size: 1100 }),
        ],
      }),
    } as unknown as Parameters<typeof provideStewardPorts>[0]);
    expect(await openPileConsolidations('p1', 'steward')).toBe(2);
    expect(debts).toHaveBeenCalledTimes(1);
    expect(debts.mock.calls[0]?.[0]).toMatchObject({
      item: { kind: 'simplify', check: 'pile:always_knowledge' },
    });
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0]).toMatchObject({
      request: { signalKey: 'pile/skill_always_on/forge-master' },
    });
  });
});
