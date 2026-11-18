import type { ReleaseState, ReleaseWaitingKind } from '@forge/contracts/releases';
import type { WaitingOn } from '@forge/contracts/standing';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';
import type { KernelActor } from '../lifecycle/index.js';

/** A cut release still holding an act, and its wait as its own page reads it. */
export interface CarryingRelease {
  version: string;
  state: ReleaseState;
  waitingOn: WaitingOn<ReleaseWaitingKind>;
}

/**
 * What suggestions and mockups do when a feedback item's reporter data is deleted, how an item about
 * a mockup names it, and which release run carries an item's carriers. Each builds on feedback, so
 * the composition root hands them in at boot rather than this module importing them.
 */
export interface FeedbackDependents {
  /** Every proposed suggestion on the item is withdrawn, in `tx`. */
  redactSuggestions(
    tx: Tx,
    feedbackId: string,
    args: { why: string; now: Date; actor: KernelActor },
  ): Promise<void>;
  /** The mockups drawn on the item, by id and MK-n, read in `tx`. */
  mockupsOf(tx: Tx, feedbackId: string): Promise<{ id: string; key: string }[]>;
  /** Every mockup of the item is deleted, in `tx`; answers the storage paths to remove after commit. */
  deleteMockups(tx: Tx, feedbackId: string): Promise<string[]>;
  /** The mockup (MK-n or uuid) an item is filed about, inside `projectId`; null where it names none there (REQ-49 BC-4). */
  mockupRefIn(projectId: string, ref: string): Promise<{ id: string; key: string } | null>;
  /** The key and name of each mockup an item is about. */
  mockupKeysOf(ids: readonly string[]): Promise<Map<string, { key: string; name: string }>>;
  /** The cut release holding an act that carries each of these issues, by issue id (`release-batch/carrying-release.ts:releaseRunsCarrying`). */
  releaseRunsCarrying(
    projectId: string,
    issueIds: readonly string[],
  ): Promise<ReadonlyMap<string, CarryingRelease>>;
}

const slot = portSlot<FeedbackDependents>('feedback', 'provideFeedbackDependents');
export const provideFeedbackDependents = slot.provide;
export const feedbackDependents = slot.get;
