// The steward's facts version (ISS-1044): which words core states a note's facts in. A note records
// the version it was written under (`steward-notes/store.ts`), and one written under another reads
// stale, so the sweep rewrites it though the item's basis never moved. adminhub-api, 2026-11-06:
// after ISS-1035 and ISS-1040 reworded the release facts and the output check's method, about twelve
// awaiting_release notes still said "lacks counting verdicts on stg" and "cut and approve the release
// for ISS-n", since nothing moved their items' bases.
// The version is a digest of every gateway act's method, so a change to what an act is told moves it
// by itself, and of `STEWARD_FACTS_REVISION`, which names the last change to the words core states
// facts in outside those methods (the release facts, `release-batch/steward-release-facts.ts`;
// the criteria weighing, `release-batch/criteria-facts.ts`), where no digest here can see it.

import { createHash } from 'node:crypto';
import { STEWARD_ACT_RUNTIME, STEWARD_ACTS } from '@forge/contracts/steward';
import { actPrompt } from './prompts.js';

/**
 * The last change to the facts a steward run is told outside its act's method: change it in the
 * change that rewords them, naming that change, and every note written before it is rewritten.
 */
export const STEWARD_FACTS_REVISION = 'ISS-1044';

/** The version of a revision and the methods the gateway acts are told: a digest of them, in order. */
export function factsVersionOf(revision: string, methods: readonly string[]): string {
  return createHash('sha256')
    .update([revision, ...methods].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/** The method each gateway act is told: a note is written by one of them, never by a runner job. */
export const gatewayMethods = (): string[] =>
  STEWARD_ACTS.filter((a) => STEWARD_ACT_RUNTIME[a] === 'gateway_turn').map((a) => actPrompt(a));

let memo: string | null = null;

/** The facts version today: one digest for the life of the process, the same on every core. */
export function stewardFactsVersion(): string {
  memo ??= factsVersionOf(STEWARD_FACTS_REVISION, gatewayMethods());
  return memo;
}
