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

const syntheticReapErrors = (): string =>
  readFileSync(join(import.meta.dirname, 'agent-session-link.ts'), 'utf8');

const action = (reason: string | null): string =>
  deriveActionFromKind(sessionLostCause(reason).failureKind);

describe('the cause a job inherits from its terminal session', () => {
  it('never retries a job whose park went unanswered', () => {
    expect(action('park_unanswered')).toBe('terminal');
  });

  it('still retries a job whose session died silently', () => {
    expect(action(null)).toBe('retry');
    expect(sessionLostCause(null).error).toBe('session_lost');
  });

  it.each(['residency_expired', 'provider_spend_cap', 'queue_timeout'])(
    'keeps the silent-death reading for %s',
    (reason) => {
      expect(action(reason)).toBe('retry');
    },
  );

  it('writes an error the session sync will not copy back', () => {
    const set = syntheticReapErrors().match(/SYNTHETIC_REAP_ERRORS = new Set\(\[[^\]]*\]/s);
    expect(set, 'the marker set could not be located').not.toBeNull();
    expect(set?.[0]).toContain(`'${sessionLostCause('park_unanswered').error}'`);
  });

  it('gives the park a cause of its own', () => {
    const parked = sessionLostCause('park_unanswered');
    const lost = sessionLostCause(null);
    expect(parked.error).not.toBe(lost.error);
    expect(parked.confirmedWedgeAction).not.toBe(lost.confirmedWedgeAction);
  });
});
