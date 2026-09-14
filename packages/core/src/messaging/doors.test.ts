import { describe, expect, it } from 'vitest';
import { cellFor } from './cells.js';
import type { DoorId, Intent } from './contract.js';
import { DOORS, doorPolicy } from './doors.js';
import { withRepairs } from './repairs.js';

const EXPECTED: ReadonlyArray<[DoorId, string, string, number | null]> = [
  ['comment-write', 'role:report', 'refusal', null],
  ['question-ask', 'role:ask', 'refusal', null],
  ['escalate', 'role:ask', 'refusal', null],
  ['question-delivery', 'role:ask', 'refusal', null],
  ['chat-sync', 'public:report', 'fallback', 1],
  ['escalation-synthesis', 'public:report', 'fallback', 1],
  ['agent-chat-completion', 'public:report', 'fallback', 0],
];

describe('the door table', () => {
  it('is exactly these seven doors — dropping one fails here', () => {
    expect(DOORS.map((d) => d.id)).toEqual(EXPECTED.map(([id]) => id));
  });

  it.each(EXPECTED)('%s screens %s and ends in %s', (id, cell, ending, repairs) => {
    const d = doorPolicy(id);
    expect(d.cell).toBe(cell);
    expect(d.ending).toBe(ending);
    expect(d.ending === 'fallback' ? d.repairs : null).toBe(repairs);
  });

  it('names a cell that exists, at every door', () => {
    for (const d of DOORS) {
      const [audience, intent] = d.cell.split(':') as [string, Intent];
      expect(cellFor(audience, intent), d.id).toBeDefined();
    }
  });

  it('says why it ends where it does, at every door', () => {
    for (const d of DOORS) expect(d.why.length).toBeGreaterThan(40);
  });

  it('declares no more than two repairs anywhere', () => {
    for (const d of DOORS) if (d.ending === 'fallback') expect(d.repairs).toBeLessThanOrEqual(2);
  });

  // cm:guard this is the property the cell/door split exists for — if every door on a cell ended the same way the split would be decoration, and a later refactor would fold it back.
  it('ends the four role:ask and role:report doors one way and the public:report doors another', () => {
    const asked = DOORS.filter((d) => d.cell === 'role:ask');
    expect(asked).toHaveLength(3);
    expect(
      new Set(asked.map((d) => ('repairs' in d ? `${d.ending}:${d.repairs}` : d.ending))).size,
    ).toBe(1);
    const reported = DOORS.filter((d) => d.cell === 'public:report');
    expect(new Set(reported.map((d) => ('repairs' in d ? d.repairs : -1))).size).toBe(2);
  });

  it('refuses a door nobody declared, by name', () => {
    expect(() => doorPolicy('not-a-door' as DoorId)).toThrow(/no door named "not-a-door"/);
  });
});

describe('the repair budget, counted in one place', () => {
  const failing = { ok: false as const, refusals: [] };
  const passing = { ok: true as const };

  it('spends a fallback door’s one repair and then stops', async () => {
    let asked = 0;
    const out = await withRepairs('chat-sync', ['bad'], {
      screen: () => failing,
      rewrite: async () => {
        asked += 1;
        return ['still bad'];
      },
    });
    expect(asked).toBe(1);
    expect(out.kind).toBe('exhausted');
    expect(out.attempts).toBe(2);
  });

  it('takes a repair that passes', async () => {
    const out = await withRepairs('chat-sync', ['bad'], {
      screen: (s) => (s[0] === 'good' ? passing : failing),
      rewrite: async () => ['good'],
    });
    expect(out).toMatchObject({ kind: 'passed', segments: ['good'], attempts: 2 });
  });

  it('asks for no repair at a door that declares none', async () => {
    let asked = 0;
    const out = await withRepairs('agent-chat-completion', ['bad'], {
      screen: () => failing,
      rewrite: async () => {
        asked += 1;
        return ['never'];
      },
    });
    expect(asked).toBe(0);
    expect(out).toMatchObject({ kind: 'exhausted', attempts: 1 });
  });

  it('asks for no repair at a refusal door either', async () => {
    let asked = 0;
    await withRepairs('comment-write', ['bad'], {
      screen: () => failing,
      rewrite: async () => {
        asked += 1;
        return ['never'];
      },
    });
    expect(asked).toBe(0);
  });
});
