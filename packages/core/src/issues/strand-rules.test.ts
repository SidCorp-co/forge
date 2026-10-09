/**
 * A takeable row the admissible list withholds waits on what withholds it, never on a dispatch:
 * a row a live run's scope holds waits on that run (REQ-36 BC-5, ISS-468).
 *
 * @direct-test-of packages/core/src/issues/strand-rules.ts
 */

import { describe, expect, it } from 'vitest';
import { withheldWait } from './strand-rules.js';

const none = { blockers: [], design: false, contract: false, pattern: false, scope: false };

describe('withheldWait', () => {
  it('names the holding run, owed by the blocker, for a row a live run scope holds', () => {
    const wait = withheldWait('open', { ...none, scope: true });
    expect(wait?.owes).toBe('blocker');
    expect(wait?.waitingFor).toContain('live run');
    expect(wait?.reason).toContain('not on a dispatch');
  });

  it('says nothing for a row nothing withholds, or one no longer takeable', () => {
    expect(withheldWait('open', none)).toBeNull();
    expect(withheldWait('in_progress', { ...none, scope: true })).toBeNull();
  });
});
