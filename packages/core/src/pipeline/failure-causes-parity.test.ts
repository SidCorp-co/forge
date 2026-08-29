/**
 * The two copies of the taxonomy must stay identical.
 *
 * Core owns the list because it writes the column and because it cannot
 * value-import `@forge/contracts` — that package is absent from the production
 * image, and a value import compiles green then crashes at boot
 * (`contracts-runtime-boundary.test.ts`, ISS-510). web-v2 cannot import core.
 * So the list exists twice, and this file is the only thing standing between
 * that and the drift it caused before ISS-877: web's hand-written union had
 * gained a cause core had retired and lost one core writes on every ack-hop
 * reap, and the operator saw a raw snake_case token for it.
 *
 * A test-time value import of contracts is the sanctioned shape here — test
 * files never reach `dist`, which is why the boundary guard skips them.
 */

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
    for (const raw of [...Object.keys(LEGACY_CAUSE_ALIAS), 'a shape nobody has seen', '']) {
      expect(contractResolve(raw), raw).toBe(resolveFailureCause(raw));
    }
    expect(contractResolve(null)).toBe(resolveFailureCause(null));
  });

  // cm:guard a cause with no presentation entry renders neutral-by-accident in web-v2 rather than red, so the exhaustiveness has to be asserted at RUNTIME too: `Record<FailureCause, …>` is checked against the CONTRACTS list, which is the copy that can silently fall behind core's.
  it('give every cause core can write a presentation web-v2 can render', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(FAILURE_CAUSE_PRESENTATION[cause], cause).toBeTruthy();
    }
  });
});
