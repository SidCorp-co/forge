// ISS-1256 c9: on 2026-11-17 four landings on forge-dev were each answered "record each term a person
// named", and none wrote one: no person names a thing inside a landing. What the mark says must name
// what counts as named, the door and the whole shape of each write, and where the agent says what it
// wrote, in both answers an agent can get.

import { describe, expect, it } from 'vitest';
import { LANDING_NAMED, LANDING_SAY, landingSaid } from './landing-said.js';

const base = '/api/projects/p1';
const placed = landingSaid({
  base,
  issueId: 'i1',
  module: { name: 'Execution', slug: 'execution', terms: 1, rules: 0, recheckOwed: 0 },
  roots: ['execution', 'platform'],
  empty: 1,
});
const unplaced = landingSaid({
  base,
  issueId: 'i1',
  module: null,
  roots: ['execution', 'platform'],
  empty: 2,
});

describe('the mark tells the landing agent what to write and through which door (ISS-1256 c9)', () => {
  for (const [name, said] of [
    ['placed', placed],
    ['unplaced', unplaced],
  ] as const) {
    it(`names what counts, the knowledge door and each write's whole shape (${name})`, () => {
      expect(said).toContain(LANDING_NAMED);
      expect(LANDING_NAMED).toContain('its decision or its code gives a thing is a term');
      expect(LANDING_NAMED).toContain('each limit or choice the work settled is a rule');
      expect(said).toContain(`PUT ${base}/knowledge/<slug> { kind: 'glossary'`);
      expect(said).toContain(
        "term: { aliases: { vi?, code?, industry? }, namedBy?: { who, quote } }, anchor: 'file.ts:symbol'",
      );
      expect(said).toContain("kind: 'rule' and its source, scope and recheckWhen");
      expect(said).toContain(LANDING_SAY);
      // the narrowing every master read as "nothing to write" is gone
      expect(said).not.toContain('a person named');
    });
  }

  it('names the module to write under where the issue is placed', () => {
    expect(placed).toContain("module: 'execution'");
    expect(placed).toContain('Execution holds 1 term and 0 rules.');
  });

  it('names the placement call and the modules to choose from where it is placed in none', () => {
    expect(unplaced).toContain(
      `PUT ${base}/modules/placements { type: 'issue', ref: 'i1', module }, module one of execution, platform`,
    );
    expect(unplaced).toContain('2 of 2 modules hold no term or rule');
  });

  it('asks no placement and no write where the project has no module (boundary, ISS-1269)', () => {
    const bare = landingSaid({ base, issueId: 'i1', module: null, roots: [], empty: 0 });
    expect(bare).toContain(`POST ${base}/labels { kind: 'module', name }`);
    expect(bare).not.toContain('modules/placements');
    expect(bare).not.toContain('/knowledge/');
  });
});
