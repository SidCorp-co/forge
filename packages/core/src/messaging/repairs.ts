/**
 * The repair round, counted in exactly one place.
 *
 * A door that owes somebody a reply may ask the writer to try again, at most
 * twice, and then posts a fixed fallback. A door that owes nobody anything is
 * not here at all: its refusal is the whole answer (ISS-997).
 */

import type { DoorId, MessageVerdict } from './contract.js';
import { doorPolicy } from './doors.js';

export interface RepairRound {
  /** Screen this attempt. */
  readonly screen: (segments: readonly string[]) => Promise<MessageVerdict> | MessageVerdict;
  /** Ask the writer for another attempt, given what broke. Never edits the text. */
  readonly rewrite: (verdict: MessageVerdict) => Promise<readonly string[]>;
}

export type RepairOutcome =
  | { readonly kind: 'passed'; readonly segments: readonly string[]; readonly attempts: number }
  | { readonly kind: 'exhausted'; readonly verdict: MessageVerdict; readonly attempts: number };

/**
 * Run a door's repair budget over an attempt.
 */
export async function withRepairs(
  door: DoorId,
  first: readonly string[],
  round: RepairRound,
): Promise<RepairOutcome> {
  const policy = doorPolicy(door);
  const budget = policy.ending === 'fallback' ? policy.repairs : 0;

  let segments = first;
  let verdict = await round.screen(segments);
  let attempts = 1;
  while (!verdict.ok && attempts <= budget) {
    segments = await round.rewrite(verdict);
    verdict = await round.screen(segments);
    attempts += 1;
  }
  return verdict.ok
    ? { kind: 'passed', segments, attempts }
    : { kind: 'exhausted', verdict, attempts };
}
