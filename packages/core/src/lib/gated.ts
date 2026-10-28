// A policy gate asked under the project's gate profile (REQ-76): an act a gate guards runs its check
// only where the gate is enforced, and a refusal it answers ends naming the gate, the profile and the
// config key that relaxes it (BC-11). Each module resolves the gate from the project document its own
// port reads (`@forge/contracts/gate-profiles:projectGate`); this only applies the answer.

import { gateEntry, gateSays, type ResolvedGate } from '@forge/contracts/gate-profiles';
import { type Refusal, RefusalError } from './refusal.js';

/** `refusal`, ending with the sentence naming its gate (once). */
export function gateRefusal<R extends Refusal>(g: ResolvedGate, refusal: R): R {
  const says = gateSays(g);
  return refusal.detail.endsWith(says)
    ? refusal
    : { ...refusal, detail: `${refusal.detail} ${says}` };
}

export function gateRefusals<R extends Refusal>(g: ResolvedGate, refusals: readonly R[]): R[] {
  return refusals.map((r) => gateRefusal(g, r));
}

/** `err` as its gate says it, where it is one of the gate's own refusals; any other error as it was. */
export function saidByGate(g: ResolvedGate, err: unknown): unknown {
  if (!(err instanceof RefusalError)) return err;
  const codes = gateEntry(g.id).codes as readonly string[];
  if (!err.refusals.some((r) => codes.includes(r.code))) return err;
  return new RefusalError(
    err.refusals.map((r) => (codes.includes(r.code) ? gateRefusal(g, r) : r)),
    err.fallbackCode,
    err.detail === undefined ? undefined : `${err.detail} ${gateSays(g)}`,
  );
}

/**
 * Runs the gate's check where the gate is enforced, re-throwing its refusal as the gate says it;
 * where the profile or an override turns it off, asks nothing and answers undefined.
 */
export async function underGate<T>(
  g: ResolvedGate,
  check: () => Promise<T>,
): Promise<T | undefined> {
  if (g.mode !== 'enforce') return undefined;
  try {
    return await check();
  } catch (err) {
    throw saidByGate(g, err);
  }
}
