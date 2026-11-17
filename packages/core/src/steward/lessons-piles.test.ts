// ISS-1251 §5, c5: a pile past its cap raises one consolidation item where it is owned, and a Tier-0
// map raises none: it carries the most used cards within its cap and reaches the rest through
// forge_find. The project's item names what is served past the cap and carries the merges the steward
// proposes over the pile's own entries, for the cleanup run to apply.
// @direct-test-of packages/core/src/steward/lessons-piles.ts

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
  past: [],
  ownerProjectId: null,
  ...row,
});

const ENTRIES = {
  always_knowledge: [
    { key: 'batch-delivery', text: 'Work moves in batches.' },
    { key: 'batch-delivery-short', text: 'Work lands in batches, gated once.' },
    { key: 'token-budget', text: 'The master orchestrates; subagents build.' },
  ],
  lessons_map: [
    { key: 'L-55', text: 'Link beta issues to the beta web host.' },
    { key: 'L-92', text: 'Link to the web host, never the API host.' },
  ],
};

const ports = (piles: PileRow[]) =>
  provideStewardPorts({
    piles: async (projectId: string) => ({ projectId, piles }),
    pileEntries: async (_p: string, pile: keyof typeof ENTRIES) => ENTRIES[pile],
  } as unknown as Parameters<typeof provideStewardPorts>[0]);

const detailOf = (n: number) =>
  (debts.mock.calls[n]?.[0] as { item: { detail: string } } | undefined)?.item.detail ?? '';

describe('a pile past its cap opens its item where it is owned', () => {
  it('opens a debt for the always-on knowledge, feedback for a skill, and nothing for a Tier-0 map', async () => {
    debts.mockClear();
    feedback.mockClear();
    ports([
      pile({ pile: 'always_knowledge', name: 'always-on knowledge', cap: 6000, size: 7000 }),
      pile({ pile: 'lessons_map', name: 'lessons map (runs)', over: false }),
      pile({ pile: 'tier0_map', name: 'map (master)' }),
      pile({ pile: 'skill_always_on', name: 'forge-master', cap: 1024, size: 1100 }),
    ]);
    expect(await openPileConsolidations('p1', 'steward', async () => null)).toBe(2);
    expect(debts).toHaveBeenCalledTimes(1);
    expect(debts.mock.calls[0]?.[0]).toMatchObject({
      item: { kind: 'simplify', check: 'pile:always_knowledge' },
    });
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(feedback.mock.calls[0]?.[0]).toMatchObject({
      request: { signalKey: 'pile/skill_always_on/forge-master' },
    });
  });

  it('names what is served past the cap and the merges proposed over its own entries, for an agent to apply (c5)', async () => {
    debts.mockClear();
    ports([
      pile({
        pile: 'always_knowledge',
        name: 'always-on knowledge',
        cap: 6000,
        size: 9468,
        past: ['token-budget'],
      }),
      pile({
        pile: 'lessons_map',
        name: 'lessons map (runs)',
        size: 1600,
        cap: 1200,
        past: ['L-92'],
      }),
    ]);
    const seen: string[] = [];
    const merge = vi.fn(async (_p: string, p: PileRow, entries: readonly { key: string }[]) => {
      seen.push(`${p.pile}: ${entries.map((e) => e.key).join(' ')}`);
      return p.pile === 'always_knowledge'
        ? [
            {
              from: ['batch-delivery', 'batch-delivery-short'],
              into: 'batch-delivery',
              says: 'Work moves and lands in batches, gated once.',
            },
            // a merge naming an entry the pile does not hold, or folding into one outside it, is dropped
            { from: ['batch-delivery', 'no-such-rule'], into: 'batch-delivery', says: 'x' },
            { from: ['batch-delivery', 'token-budget'], into: 'elsewhere', says: 'y' },
          ]
        : [{ from: ['L-55', 'L-92'], into: 'L-92', says: 'Link to the web host, beta too.' }];
    });
    expect(await openPileConsolidations('p1', 'steward', merge)).toBe(2);
    expect(seen).toEqual([
      'always_knowledge: batch-delivery batch-delivery-short token-budget',
      'lessons_map: L-55 L-92',
    ]);
    const knowledge = detailOf(0);
    expect(knowledge).toContain('Served past the cap: token-budget.');
    expect(knowledge).toContain(
      'Merges proposed: (1) batch-delivery + batch-delivery-short into batch-delivery: "Work moves and lands in batches, gated once."',
    );
    expect(knowledge).toContain('PUT /api/projects/:id/knowledge/<into>');
    expect(knowledge).not.toContain('no-such-rule');
    expect(knowledge).not.toContain('elsewhere');
    const lessons = detailOf(1);
    expect(lessons).toContain('Served past the cap: L-92.');
    expect(lessons).toContain('(1) L-55 + L-92 into L-92: "Link to the web host, beta too."');
    expect(lessons).toContain('/lessons/<n>/confusions');
    expect(lessons.length).toBeLessThanOrEqual(2000);
  });
});
