/**
 * The cause a freed job inherits, and the action that follows from it.
 *
 * The whole point of the split is the ACTION: `infra` retries and `code` does
 * not, so these assert the derived action rather than only the kind — a kind
 * asserted alone would keep passing if the mapping it was chosen for moved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveActionFromKind } from '../pipeline/failure-classifier.js';
import { sessionLostCause } from './session-lost-cause.js';

// cm:guard read from the SOURCE rather than imported: `agent-session-link.ts` pulls `db/client.ts`, which validates env at module load, so importing the set here would make this hermetic suite need a database to assert a string.
const syntheticReapErrors = (): string =>
  readFileSync(join(import.meta.dirname, 'agent-session-link.ts'), 'utf8');

const action = (reason: string | null): string =>
  deriveActionFromKind(sessionLostCause(reason).failureKind);

describe('the cause a job inherits from its terminal session', () => {
  // cm:guard THE business rule: a park nobody answered must not be retried. Asserted through `deriveActionFromKind` because that is the function whose answer actually decides it — `failureKind: 'code'` is only the means.
  it('never retries a job whose park went unanswered', () => {
    expect(action('park_unanswered')).toBe('terminal');
  });

  it('still retries a job whose session died silently', () => {
    expect(action(null)).toBe('retry');
    expect(sessionLostCause(null).error).toBe('session_lost');
  });

  // cm:guard an unrecognised reason keeps the hop's historical reading. Defaulting the other way would silence retry for every cause `deriveSessionFailure` learns to write next.
  it.each(['residency_expired', 'provider_spend_cap', 'queue_timeout'])(
    'keeps the silent-death reading for %s',
    (reason) => {
      expect(action(reason)).toBe('retry');
    },
  );

  // cm:guard the park's error word must be a synthetic marker, or the lifecycle sync writes this job cause back over the session's own `park_unanswered` and the diagnosis is erased. Asserted here rather than trusted to the `cm:edge`, because nothing else fails when the two drift.
  it('writes an error the session sync will not copy back', () => {
    const set = syntheticReapErrors().match(/SYNTHETIC_REAP_ERRORS = new Set\(\[[^\]]*\]/s);
    expect(set, 'the marker set could not be located').not.toBeNull();
    expect(set?.[0]).toContain(`'${sessionLostCause('park_unanswered').error}'`);
  });

  // cm:guard the two causes must not converge: a single shared string would make the operator-facing wedge text and the retry decision identical again, which is the defect this module exists to undo.
  it('gives the park a cause of its own', () => {
    const parked = sessionLostCause('park_unanswered');
    const lost = sessionLostCause(null);
    expect(parked.error).not.toBe(lost.error);
    expect(parked.confirmedWedgeAction).not.toBe(lost.confirmedWedgeAction);
  });
});
