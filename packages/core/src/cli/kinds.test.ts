import { describe, expect, it } from 'vitest';
import {
  CAUSE,
  HAPPENED,
  KINDS,
  KIND_NAMES,
  OUTCOME,
  RULES,
  SCOPE,
  TODAY,
  WHERE,
  WHY,
  article,
  didYouMean,
  kindNeeded,
  kindRefusal,
  shapeFor,
} from './kinds.js';

describe('the kinds table', () => {
  it('defines exactly the four kinds the terminal defines', () => {
    expect(KIND_NAMES).toEqual(['bug', 'enhancement', 'feature', 'review']);
  });

  it("owes a bug what happened, why it happens, the outcome, the rules and what is out of scope", () => {
    expect(shapeFor('bug')?.needs).toEqual([HAPPENED, CAUSE, OUTCOME, RULES, SCOPE]);
  });

  it('owes an enhancement what happens today rather than what happened', () => {
    expect(shapeFor('enhancement')?.needs).toEqual([TODAY, OUTCOME, RULES, SCOPE]);
  });

  it('owes a feature the outcome, the rules and the scope, and no account of a past', () => {
    expect(shapeFor('feature')?.needs).toEqual([OUTCOME, RULES, SCOPE]);
  });

  it('owes a review the same three as a feature', () => {
    expect(shapeFor('review')?.needs).toEqual([OUTCOME, RULES, SCOPE]);
  });

  it('asks a bug for Where and every other kind for Why, and refuses neither', () => {
    expect(shapeFor('bug')?.says).toEqual([WHERE]);
    for (const kind of ['enhancement', 'feature', 'review']) {
      expect(shapeFor(kind)?.says).toEqual([WHY]);
    }
  });

  it('answers with nothing for a kind it does not define, rather than a default', () => {
    expect(shapeFor('chore')).toBeNull();
    expect(shapeFor('')).toBeNull();
  });

  it('holds no kind whose required and nice-to-have sets overlap', () => {
    for (const kind of KINDS) {
      for (const part of kind.says) expect(kind.needs).not.toContain(part);
    }
  });

  it('lets the out-of-scope section be spoken in a sentence, and no other section', () => {
    expect(SCOPE.spoken).not.toBeNull();
    for (const part of [OUTCOME, RULES, HAPPENED, CAUSE, TODAY, WHERE, WHY]) {
      expect(part.spoken).toBeNull();
    }
  });

  it('holds the out-of-scope section to presence and every other one to a substantial line', () => {
    expect(SCOPE.substantial).toBe(false);
    for (const part of [OUTCOME, RULES, HAPPENED, CAUSE, TODAY]) expect(part.substantial).toBe(true);
  });
});

describe('article', () => {
  it('takes an before a vowel and a before anything else', () => {
    expect(article('enhancement')).toBe('an');
    expect(article('outcome')).toBe('an');
    expect(article('bug')).toBe('a');
    expect(article('feature')).toBe('a');
  });
});

describe('the refusals the table owns', () => {
  it('names the nearest kind for a near miss', () => {
    expect(didYouMean('category', 'bugs', KIND_NAMES)).toContain('Did you mean: bug?');
  });

  it('names the whole set even where nothing is near', () => {
    const said = didYouMean('category', 'zzzzzzzz', KIND_NAMES);
    expect(said).toContain('The set is bug, enhancement, feature, review.');
    expect(said).not.toContain('Did you mean');
  });

  it('quotes back the value it was given', () => {
    expect(didYouMean('category', 'chore', KIND_NAMES)).toContain('No category named chore.');
  });

  it('refuses an undefined kind by naming the four and the route past the set', () => {
    const said = kindRefusal('chore');
    expect(said).toContain('No category named chore.');
    expect(said).toContain('bug, enhancement, feature, review');
    expect(said).toContain('files an issue against the plugin rather than inventing the value');
  });

  it('refuses a filing that named none by naming the four and why the field is needed', () => {
    const said = kindNeeded();
    expect(said).toContain('bug, enhancement, feature, review');
    expect(said).toContain('which sections the body is read against');
  });
});
