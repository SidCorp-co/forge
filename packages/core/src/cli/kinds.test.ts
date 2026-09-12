import { describe, expect, it } from 'vitest';
import { KIND_NAMES, KINDS, kindNeeded, kindRefusal, shapeFor } from './kinds.js';

describe('the kinds this CLI layer defines', () => {
  it('defines four, and every kind requires an outcome, rules and an out-of-scope', () => {
    expect(KIND_NAMES).toEqual(['bug', 'enhancement', 'feature', 'review']);
    for (const one of KINDS) {
      const required = one.needs.map((s) => s.title);
      expect(required, `${one.kind} drops one of the three every kind owes`).toEqual(
        expect.arrayContaining(['Outcome', 'Rules', 'Out of scope']),
      );
    }
  });

  it('a bug is the one kind that owes where the defect comes from', () => {
    const owes = KINDS.filter((one) => one.needs.some((s) => s.title === 'Why it happens'));
    expect(owes.map((one) => one.kind)).toEqual(['bug']);
  });

  it('resolves a defined category and refuses to invent one', () => {
    expect(shapeFor('bug')?.kind).toBe('bug');
    expect(shapeFor('chore')).toBeNull();
  });
});

describe('the refusals that name the set', () => {
  it('a filing naming no category is told the four it may be', () => {
    const text = kindNeeded();
    for (const kind of KIND_NAMES) expect(text).toContain(kind);
  });

  it('a filing naming an undefined category is told the four this layer defines', () => {
    const text = kindRefusal('chore');
    expect(text).toContain('chore');
    for (const kind of KIND_NAMES) expect(text).toContain(kind);
  });
});
