import { describe, expect, it } from 'vitest';
import { isSkillLocked, readLockedSkills, skillLockReason } from './lock.js';

describe('skillLockReason', () => {
  it('locks a Forge-reserved name with no declaration at all', () => {
    expect(skillLockReason('forge-reconcile', {})).toBe('forge-reserved');
  });

  // cm:guard the reason the union is one-directional: an empty array must not read as "unlock everything", or a project could shadow the agent that polices its own updates
  it('refuses to let a project declaration unlock a Forge-reserved name', () => {
    expect(skillLockReason('forge-reconcile', { declared: [] })).toBe('forge-reserved');
    expect(skillLockReason('forge-verify-skill', { declared: ['something-else'] })).toBe(
      'forge-reserved',
    );
  });

  it('locks the whole surface when the project declares true', () => {
    expect(skillLockReason('anything-at-all', { declared: true })).toBe('project-declared');
  });

  it('locks only the named skills when the project declares a list', () => {
    expect(skillLockReason('forge-triage', { declared: ['forge-triage'] })).toBe(
      'project-declared',
    );
    expect(skillLockReason('forge-code', { declared: ['forge-triage'] })).toBeNull();
  });

  it('leaves an ordinary project skill writable when nothing declares otherwise', () => {
    expect(isSkillLocked('my-custom-skill', { declared: [] })).toBe(false);
  });
});

describe('readLockedSkills', () => {
  it('reads the two shapes it accepts', () => {
    expect(readLockedSkills({ lockedSkills: true })).toBe(true);
    expect(readLockedSkills({ lockedSkills: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  // cm:guard a malformed lock must read as ABSENT, never coerced: "locked" would block every skill write on the project, and "unlocked" would silently drop a protection someone believed they had declared
  it('treats a malformed declaration as absent rather than guessing', () => {
    expect(readLockedSkills({ lockedSkills: 'forge-drive' })).toBeUndefined();
    expect(readLockedSkills({ lockedSkills: ['a', 42] })).toBeUndefined();
    expect(readLockedSkills({ lockedSkills: false })).toBeUndefined();
    expect(readLockedSkills({})).toBeUndefined();
    expect(readLockedSkills(null)).toBeUndefined();
    expect(readLockedSkills('nonsense')).toBeUndefined();
  });
});
