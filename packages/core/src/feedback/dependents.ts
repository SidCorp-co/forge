import type { Tx } from '../db/client.js';
import type { KernelActor } from '../lifecycle/index.js';

/**
 * What suggestions and mockups do when a feedback item's reporter data is deleted. Both build on
 * feedback, so the composition root hands them in at boot rather than this module importing them.
 */
export interface FeedbackDependents {
  /** Every proposed suggestion on the item is withdrawn, in `tx`. */
  redactSuggestions(
    tx: Tx,
    feedbackId: string,
    args: { why: string; now: Date; actor: KernelActor },
  ): Promise<void>;
  /** Every mockup of the item is deleted, in `tx`; answers the storage paths to remove after commit. */
  deleteMockups(tx: Tx, feedbackId: string): Promise<string[]>;
}

let dependents: FeedbackDependents | null = null;

export function provideFeedbackDependents(provided: FeedbackDependents): void {
  dependents = provided;
}

export function feedbackDependents(): FeedbackDependents {
  if (!dependents) {
    throw new Error(
      'feedback: no dependents were provided, so a redaction cannot reach its suggestions and mockups; the process entry calls provideFeedbackDependents() before it serves',
    );
  }
  return dependents;
}
