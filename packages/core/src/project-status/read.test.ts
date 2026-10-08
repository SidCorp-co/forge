import { say, verbatim } from '@forge/contracts/said';
import { type Standing, waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import type { AttentionRow } from '../development/index.js';
import { requirementsShippedOf, waitsOf } from './read.js';

// What a person reads about where a project stands must be what a member owes and what was proven
// (HOP journey walk, 2026-10-08): an agent report's triage is Forge upkeep, and "delivered in full"
// is a claim about every live criterion, not about the last issue shipping.

const AS_OF = '2026-10-08T09:00:00.000Z';

function row(
  entity: AttentionRow['entity'],
  key: string,
  wait: Standing['waitingOn'],
  touchedAt: string,
  group: Standing['attentionGroup'] = 'waiting',
): AttentionRow {
  return {
    entity,
    key,
    title: key,
    titleLang: null,
    says: { title: verbatim(key) },
    standing: { attentionGroup: group, waitingOn: wait },
    touchedAt,
  };
}

const writers = waitingOn('writers', {
  who: say('standing.who.named', { name: 'Ana, Bo' }),
  act: say('standing.act.triageReport'),
  rule: say('automation.rule.toWriters'),
});
const you = waitingOn('you', {
  who: say('standing.who.you'),
  act: say('standing.act.approve'),
  rule: say('standing.text', { text: 'asked' }),
});
const minh = waitingOn('person', {
  who: say('standing.who.named', { name: 'Minh' }),
  act: say('standing.act.approveDesign', { what: 'hop-intake' }),
  rule: say('standing.text', { text: 'a revision waits' }),
});

describe("the status report's waiting-on-people list", () => {
  const reports = Array.from({ length: 85 }, (_, i) =>
    row('report', `r${i}`, writers, `2026-10-08T0${i % 9}:00:00.000Z`),
  );
  const read = waitsOf(
    {
      automation: reports,
      issues: [row('issue', 'ISS-107', you, '2026-10-07T10:00:00.000Z', 'needs_you')],
      designs: [
        row('workflow', 'hop-recall-ux', minh, '2026-10-07T12:00:00.000Z'),
        row('workflow', 'hop-intake', minh, '2026-10-06T12:00:00.000Z'),
      ],
      requirements: [row('requirement', 'REQ-31', you, '2026-10-07T08:00:00.000Z', 'needs_you')],
    },
    AS_OF,
  );

  it('lists no agent report: triaging one is Forge ops upkeep, read in Development', () => {
    expect(read.people.map((w) => w.area)).not.toContain('automation');
    expect(read.peopleCount).toBe(4);
  });

  it("lists the member's own asks, grouped by person, the reader first, each person's oldest first", () => {
    expect(read.byPerson?.map((p) => [p.kind, p.who, p.count])).toEqual([
      ['you', 'You', 2],
      ['person', 'Minh', 2],
    ]);
    expect(read.people.map((w) => w.key)).toEqual([
      'REQ-31',
      'ISS-107',
      'hop-intake',
      'hop-recall-ux',
    ]);
  });

  it("counts the reader's own asks as the home and /attention do", () => {
    expect(read.needsYou).toBe(2);
  });
});

describe('delivered in full', () => {
  const since = new Date('2026-10-01T00:00:00.000Z');
  const shipped = (key: string) => ({
    key,
    title: key,
    delivery: { shipped: { version: '0.5.0', at: '2026-10-07T10:00:00.000Z' } } as never,
  });
  const coverage = (key: string, passing: number, criteria: number) => ({
    key,
    delivery: {
      criteriaCoverage: { passing, criteria, judged: passing },
    } as never,
  });

  const read = requirementsShippedOf(
    [shipped('REQ-23'), shipped('REQ-2'), shipped('REQ-25'), shipped('REQ-9')],
    [
      coverage('REQ-23', 0, 7),
      coverage('REQ-2', 13, 14),
      coverage('REQ-25', 9, 9),
      coverage('REQ-9', 0, 0),
    ],
    since,
  );

  it('is never said of a requirement with an unproven live criterion (REQ-23 at 0/7, REQ-2 short of BC-14)', () => {
    expect(read.inFull.map((r) => r.key)).toEqual(['REQ-25']);
  });

  it('says what shipped and is still unproven, with its proof', () => {
    expect(read.awaitingProof.map((r) => [r.key, r.proven, r.total])).toEqual([
      ['REQ-23', 0, 7],
      ['REQ-2', 13, 14],
      ['REQ-9', 0, 0],
    ]);
  });

  it('refuses by name a shipped requirement the list read no coverage for', () => {
    expect(() => requirementsShippedOf([shipped('REQ-40')], [], since)).toThrow(/REQ-40/);
  });
});
