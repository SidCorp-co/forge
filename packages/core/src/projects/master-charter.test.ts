// A charter write of the wrong shape is refused naming what arrived, with its own article: "an
// object", "a list", "null", never "a object" or "a array" built from a type's name.

import { describe, expect, it } from 'vitest';
import { parseMasterCharterWrite } from './master-charter.js';

const said = (raw: unknown) => {
  const parsed = parseMasterCharterWrite(raw);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.refusal.message;
};

describe('a charter write of the wrong shape', () => {
  it('names what arrived with the article its words take', () => {
    expect(said({ goal: {}, rules: [] })).toContain('This one is an object.');
    expect(said({ goal: ['x'], rules: [] })).toContain('This one is a list.');
    expect(said({ goal: 'Ship it.', rules: {} })).toContain('This one is an object —');
    expect(said({ goal: 'Ship it.', rules: [null] })).toBe(
      '`rules[0]` is null, and every rule is a string.',
    );
    expect(said({ goal: 'Ship it.', rules: [[]] })).toBe(
      '`rules[0]` is a list, and every rule is a string.',
    );
    for (const raw of [{ goal: {} }, { goal: 'x', rules: {} }, { goal: 'x', rules: [{}] }]) {
      expect(said(raw)).not.toMatch(/\ba (object|array|undefined)\b/);
    }
  });
});
