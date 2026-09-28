import { describe, expect, it } from 'vitest';
import {
  MASTER_CHARTER_GOAL_MAX,
  MASTER_CHARTER_IS_A_PERSONS_WRITE,
  MASTER_CHARTER_RULE_MAX,
  MASTER_CHARTER_RULES_MAX,
  masterCharterPath,
  parseMasterCharterWrite,
} from './master-charter.js';

describe('masterCharterPath', () => {
  it('builds the path a master.wake frame points at, from the project id alone', () => {
    expect(masterCharterPath('proj-1')).toBe('/api/projects/proj-1/master-charter');
  });
});

describe('MASTER_CHARTER_IS_A_PERSONS_WRITE', () => {
  it('is a sentence, not a bare code', () => {
    expect(MASTER_CHARTER_IS_A_PERSONS_WRITE.length).toBeGreaterThan(20);
  });
});

describe('parseMasterCharterWrite — happy', () => {
  it('accepts a goal and a list of rules', () => {
    const parsed = parseMasterCharterWrite({
      goal: 'ship the thing',
      rules: ['rule one', 'rule two'],
    });
    expect(parsed).toEqual({
      ok: true,
      value: { goal: 'ship the thing', rules: ['rule one', 'rule two'] },
    });
  });

  it('accepts an empty rules array', () => {
    const parsed = parseMasterCharterWrite({ goal: 'ship the thing', rules: [] });
    expect(parsed).toEqual({ ok: true, value: { goal: 'ship the thing', rules: [] } });
  });

  it('accepts a goal exactly at the character limit', () => {
    const goal = 'g'.repeat(MASTER_CHARTER_GOAL_MAX);
    const parsed = parseMasterCharterWrite({ goal, rules: [] });
    expect(parsed.ok).toBe(true);
  });

  it('accepts rules exactly at the count limit', () => {
    const rules = Array.from({ length: MASTER_CHARTER_RULES_MAX }, (_, i) => `rule ${i}`);
    const parsed = parseMasterCharterWrite({ goal: 'g', rules });
    expect(parsed.ok).toBe(true);
  });

  it('accepts a rule exactly at the character limit', () => {
    const rules = ['r'.repeat(MASTER_CHARTER_RULE_MAX)];
    const parsed = parseMasterCharterWrite({ goal: 'g', rules });
    expect(parsed.ok).toBe(true);
  });
});

describe('parseMasterCharterWrite — negative and boundary (criteria 10-13, 36-38)', () => {
  it('is not an object at all', () => {
    const parsed = parseMasterCharterWrite('not an object');
    expect(parsed).toEqual({
      ok: false,
      refusal: { field: 'body', message: expect.stringContaining('not an object at all') },
    });
  });

  it('refuses an unknown field rather than storing it under a name nothing reads', () => {
    const parsed = parseMasterCharterWrite({ goal: 'g', rules: [], extra: 'nope' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('extra');
      expect(parsed.refusal.message).toContain('extra');
    }
  });

  it('refuses a goal that is not a string', () => {
    const parsed = parseMasterCharterWrite({ goal: 42, rules: [] });
    expect(parsed).toEqual({
      ok: false,
      refusal: { field: 'goal', message: expect.stringContaining('goal') },
    });
  });

  it('refuses an absent goal, naming it absent rather than a type', () => {
    const parsed = parseMasterCharterWrite({ rules: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.message).toContain('absent');
  });

  it('refuses an empty goal (criterion 10)', () => {
    const parsed = parseMasterCharterWrite({ goal: '', rules: [] });
    expect(parsed).toEqual({
      ok: false,
      refusal: { field: 'goal', message: expect.stringContaining('goal') },
    });
  });

  it('refuses a whitespace-only goal without trimming it into something valid (criterion 10)', () => {
    const parsed = parseMasterCharterWrite({ goal: '   \n\t  ', rules: [] });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a goal one character past the limit (criterion 13)', () => {
    const goal = 'g'.repeat(MASTER_CHARTER_GOAL_MAX + 1);
    const parsed = parseMasterCharterWrite({ goal, rules: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('goal');
      expect(parsed.refusal.message).toContain(String(MASTER_CHARTER_GOAL_MAX));
    }
  });

  it('refuses rules sent as a string rather than reading it as a one-rule list (criterion 11)', () => {
    const parsed = parseMasterCharterWrite({ goal: 'g', rules: 'only one rule' });
    expect(parsed).toEqual({
      ok: false,
      refusal: { field: 'rules', message: expect.stringContaining('not read as a list of one') },
    });
  });

  it('refuses rules one entry past the count limit (criterion 37)', () => {
    const rules = Array.from({ length: MASTER_CHARTER_RULES_MAX + 1 }, (_, i) => `rule ${i}`);
    const parsed = parseMasterCharterWrite({ goal: 'g', rules });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('rules');
      expect(parsed.refusal.message).toContain(String(MASTER_CHARTER_RULES_MAX));
    }
  });

  it('refuses a rule that is not a string, naming its position (criterion 12)', () => {
    const parsed = parseMasterCharterWrite({ goal: 'g', rules: ['fine', 42, 'also fine'] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('rules[1]');
  });

  it('refuses an empty rule where it stands rather than dropping it (criterion 12)', () => {
    const parsed = parseMasterCharterWrite({ goal: 'g', rules: ['fine', '   ', 'also fine'] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('rules[1]');
      expect(parsed.refusal.message).toContain('empty');
    }
  });

  it('refuses a rule one character past the limit, naming its position (criterion 38)', () => {
    const rules = ['fine', 'r'.repeat(MASTER_CHARTER_RULE_MAX + 1)];
    const parsed = parseMasterCharterWrite({ goal: 'g', rules });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('rules[1]');
      expect(parsed.refusal.message).toContain(String(MASTER_CHARTER_RULE_MAX));
    }
  });

  it('refuses an absent rules field rather than defaulting to empty', () => {
    const parsed = parseMasterCharterWrite({ goal: 'g' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('rules');
  });
});
