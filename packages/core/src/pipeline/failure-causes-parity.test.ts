import {
  LEGACY_CAUSE_ALIAS as CONTRACT_ALIAS,
  FAILURE_CAUSES as CONTRACT_CAUSES,
  resolveFailureCause as contractResolve,
  FAILURE_CAUSE_PRESENTATION,
} from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { FAILURE_CAUSES, LEGACY_CAUSE_ALIAS, resolveFailureCause } from './failure-causes.js';

describe('the core and contracts copies of the taxonomy', () => {
  it('hold the same causes, in the same order', () => {
    expect([...CONTRACT_CAUSES]).toEqual([...FAILURE_CAUSES]);
  });

  it('resolve every legacy spelling the same way', () => {
    expect(CONTRACT_ALIAS).toEqual(LEGACY_CAUSE_ALIAS);
    for (const raw of [
      ...Object.keys(LEGACY_CAUSE_ALIAS),
      'a shape nobody has seen',
      'toString',
      'constructor',
      '',
    ]) {
      expect(contractResolve(raw), raw).toBe(resolveFailureCause(raw));
    }
    expect(contractResolve(null)).toBe(resolveFailureCause(null));
  });

  it('give every cause core can write a presentation web-v2 can render', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(FAILURE_CAUSE_PRESENTATION[cause], cause).toBeTruthy();
    }
  });
});
