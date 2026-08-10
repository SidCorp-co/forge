import { describe, expect, it } from 'vitest';
import { META_SKILL_NAMES, MetaSkillReservedError, isMetaSkillName } from './meta-skills.js';

describe('isMetaSkillName', () => {
  it('returns true for a reserved meta-skill name', () => {
    expect(isMetaSkillName('forge-onboard')).toBe(true);
  });

  it('returns false for an ordinary project skill name', () => {
    expect(isMetaSkillName('forge-code')).toBe(false);
  });

  // cm:why the no-adopt rule for the Forge-owned reconcile agents is enforced HERE, not by the prompt inlining — inlining only stops Forge READING a project fork, it does not stop one being created via adopt/create/rename
  it.each(['forge-reconcile', 'forge-verify-skill'])(
    'reserves the Forge-owned governing agent %s so no project can adopt or shadow it',
    (name) => {
      expect(isMetaSkillName(name)).toBe(true);
    },
  );

  it('matches META_SKILL_NAMES exactly (no case-folding, no partial match)', () => {
    expect(isMetaSkillName('Forge-Onboard')).toBe(false);
    expect(isMetaSkillName('forge-onboard-extra')).toBe(false);
    for (const name of META_SKILL_NAMES) {
      expect(isMetaSkillName(name)).toBe(true);
    }
  });
});

describe('MetaSkillReservedError', () => {
  it('carries the META_SKILL_RESERVED code and names the reserved skill', () => {
    const err = new MetaSkillReservedError('forge-onboard');
    expect(err.code).toBe('META_SKILL_RESERVED');
    expect(err.message).toContain('forge-onboard');
    expect(err.message).toContain('plugin channel');
  });
});
