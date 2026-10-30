/**
 * ISS-684: every code a Delivery hold can carry reads as one plain sentence a person understands,
 * and every release hold names a verb that clears it. A code with no sentence, or one that leaks a
 * code into its words, fails here by the code's name.
 */

import { FAILURE_CAUSES } from '@forge/contracts/failure-causes';
import { RUN_GATES, RUN_STUCK_RULES } from '@forge/contracts/run-standing';
import { sayEn } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { releaseHoldWords, WORDED_RELEASE_HOLDS } from '../issues/index.js';
import { failureCause, gateCause, personCause, stuckCause } from './hold-causes.js';

const CODE = /[a-z]+_[a-z_]+|[A-Z]{3,}_[A-Z_]+/;
const JOB_HOLD_REASONS = ['retry_rounds_exhausted', 'non_retryable_terminal'];
const GENERIC_GATES = [
  'blocked_on_machine',
  'blocked_on_master_or_peer',
  'paused',
  'a_gate_nobody_named',
];

/** The verbs a release hold's act may open with: base form, so "<who> · <act>" reads as an instruction. */
const VERBS = new Set(
  'judge back make route declare fix take record name clear finish try bring bind settle file write land split decide merge release run'.split(
    ' ',
  ),
);

const plain = (what: string, text: string) => {
  expect(text, `${what} leaks a code: "${text}"`).not.toMatch(CODE);
  expect(text.charAt(0), `${what} does not open as a sentence: "${text}"`).toMatch(/[A-Z]/);
};

describe('a hold cause is one plain sentence', () => {
  it('for every failure cause', () => {
    for (const c of FAILURE_CAUSES) plain(c, sayEn(failureCause(c)));
  });

  it('for every gate, job hold reason and gate it has no sentence of its own for', () => {
    for (const g of [...RUN_GATES, ...JOB_HOLD_REASONS, ...GENERIC_GATES])
      plain(g, sayEn(gateCause(g)));
    plain('a person wait', sayEn(personCause()));
  });

  it('for every stuck rule, and a stuck run with no rule', () => {
    for (const r of RUN_STUCK_RULES) plain(r, sayEn(stuckCause(r)));
    plain('no rule', sayEn(stuckCause(null)));
  });

  it('for every release hold code, and one it has no words for, each with a verb that clears it', () => {
    const codes = [...WORDED_RELEASE_HOLDS, 'RELEASE_SOMETHING_NEW'];
    for (const code of codes) {
      for (const owes of ['human', 'agent'] as const) {
        const w = releaseHoldWords({ code, owes });
        plain(code, sayEn(w.cause));
        const act = sayEn(w.act);
        expect(act, `${code}'s act leaks a code`).not.toMatch(CODE);
        expect(
          VERBS.has(act.split(' ')[0] ?? ''),
          `${code}'s act is not a verb phrase: "${act}"`,
        ).toBe(true);
      }
    }
  });
});
