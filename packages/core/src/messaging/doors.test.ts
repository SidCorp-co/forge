import { describe, expect, it } from 'vitest';
import { cellFor } from './cells.js';
import type { DoorId, Intent } from './contract.js';
import { cellPair, DOORS, doorCell, doorPolicy } from './doors.js';
import { withRepairs } from './repairs.js';

const EXPECTED: ReadonlyArray<[DoorId, string, string, number | null]> = [
  ['comment-write', 'role:report', 'refusal', null],
  ['question-ask', 'role:ask', 'refusal', null],
  ['question-delivery', 'role:ask', 'refusal', null],
  ['chat-sync', 'public:report', 'fallback', 1],
  ['web-chat-reply', 'role:chat', 'fallback', 1],
  ['escalation-synthesis', 'public:report', 'fallback', 1],
  ['agent-chat-completion', 'public:report', 'fallback', 0],
  ['web-agent-completion', 'role:chat', 'fallback', 0],
];

describe('the door table', () => {
  it('is exactly these eight doors — dropping one fails here', () => {
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
  // cm:guard this is the property the cell/door split exists for. If every door on a cell carried the same policy the split would be decoration and a later refactor would fold it back — `public:report` is read at three doors that repair 1, 1 and 0 times, and no single number on the cell could have been right for all three.
  it('gives the three public:report doors two different repair counts', () => {
    const reported = DOORS.filter((d) => d.cell === 'public:report');
    expect(reported).toHaveLength(3);
    expect(new Set(reported.map((d) => ('repairs' in d ? d.repairs : -1)))).toEqual(
      new Set([0, 1]),
    );
  });

  // cm:guard the Forge UI reply is on a cell of its OWN and must not drift back onto `role:report`: ISS-1005's review caught that move dropping `only-verified-citations`, `no-empty-promise` and `progress-figures-match`, three rules that are about the turn rather than the reader, and the last of those cannot be added to `role:report` because `screenAgentComment` gathers no progress and the rule fails closed. This reds if somebody folds the two back together (ISS-1005).
  // cm:guard `role:chat` is read at TWO doors since ISS-1039 and the property this case defends is
  // unchanged: the cell is the Forge UI's and nothing else's. What the second door adds is a repair
  // count, which is the same argument `public:report` makes three doors down — the reader is one
  // person and the budget is the lane's.
  it('reads the browser reply at a cell no other surface reads', () => {
    const chat = DOORS.filter((d) => d.cell === 'role:chat');
    expect(chat.map((d) => d.id)).toEqual(['web-chat-reply', 'web-agent-completion']);
    const spec = cellFor('role', 'chat');
    expect(spec?.rules.map((r) => r.id)).toEqual([
      'non-empty',
      'status-matches-the-row',
      'only-verified-citations',
      'issue-link-shape',
      'no-empty-promise',
      'progress-figures-match',
      'no-redacted-secret',
    ]);
    // cm:guard the ONE rule the move was for, asserted as absent by name rather than left to the list above to imply: `no-developer-detail` is why this cell exists, and a reader adding it back would be undoing ISS-1005 without meeting anything that says so.
    expect(spec?.rules.map((r) => r.id)).not.toContain('no-developer-detail');
  });

  // cm:guard every door's reason is its OWN, across the whole table: a row copied from the nearest existing one is the failure the door table exists to prevent, and it reads identically to a row that was thought about (ISS-1005).
  it('gives every door a reason no other door states', () => {
    expect(new Set(DOORS.map((d) => d.why)).size).toBe(DOORS.length);
  });

  // cm:guard the two `role:ask` doors end the same way for DIFFERENT reasons, and the reasons are what the door table carries: one has the agent still on the line, the other posts into a room with nobody left to ask. One `why` shared between them would be the first step back to a policy on the cell.
  it('gives the two role:ask doors the same ending and different reasons for it', () => {
    const asked = DOORS.filter((d) => d.cell === 'role:ask');
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((d) => d.ending))).toEqual(new Set(['refusal']));
    expect(new Set(asked.map((d) => d.why)).size).toBe(2);
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

describe('the pair a door screens at, read off its own row', () => {
  it('gives every shipped door the audience and the intent its cell names', () => {
    for (const [id, cell] of EXPECTED.map(([id, cell]) => [id, cell] as const)) {
      const { audience, intent } = doorCell(id);
      expect(`${audience}:${intent}`).toBe(cell);
    }
  });

  // cm:guard an audience is an open string and nothing forbids a colon in one, so the cut is at the LAST colon: cutting at the first would hand `internal:operator:report` back as audience `internal` and intent `operator`, which names no cell, and that door would then refuse every message it screened while saying only that the pair is unknown.
  it('keeps an audience that carries a colon of its own whole', () => {
    const { audience, intent } = doorCell('chat-sync');
    expect(`${audience}:${intent}`).toBe('public:report');

    expect(cellPair('internal:operator:report')).toEqual({
      audience: 'internal:operator',
      intent: 'report',
    });
  });
});
