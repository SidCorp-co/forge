import { describe, expect, it } from 'vitest';
import { isSkillLocked, readLockedSkills, skillLockReason } from './lock.js';

const BUNDLED = ['forge-drive', 'forge-understand', 'forge-plan', 'forge-review', 'forge-ship'];

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

  // cm:guard the lock follows the DEFAULT, not the literal. Since 2026-09-02 an absent `mode` resolves autonomous, so a project that never chose runs the bundled skills — and leaving them editable there is a skill the runner overwrites from the binary on the next job while the project believes its edit took.
  it('locks the bundled set wherever the project resolves autonomous, chosen or defaulted', () => {
    expect(skillLockReason('forge-drive', { bundled: BUNDLED, mode: 'autonomous' })).toBe(
      'autonomous-mode',
    );
    expect(skillLockReason('forge-drive', { bundled: BUNDLED })).toBe('autonomous-mode');
    expect(skillLockReason('forge-drive', { bundled: BUNDLED, mode: 'staged' })).toBeNull();
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
    expect(isSkillLocked('my-custom-skill', { bundled: BUNDLED, mode: 'staged' })).toBe(false);
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
