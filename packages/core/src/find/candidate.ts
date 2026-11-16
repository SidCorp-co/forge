// A record as an arm of the find door answers it, before the fusion ranks it and the shape groups it.

import type { FindMatchArm, FindType } from '@forge/contracts/find';
import type { PlacedKind } from './model-reads.js';

export interface Candidate {
  /** `<type>:<ref>`, the hit's id. */
  id: string;
  type: FindType;
  ref: string;
  key: string | null;
  title: string;
  text: string;
  /** Null for what every project shares: a card, an org ruling. */
  projectId: string | null;
  status: string | null;
  /**
   * What places it (a row's `module_id`, a card's code module) and the id it is read by; null where
   * nothing can.
   */
  placed: { kind: PlacedKind; id: string } | null;
  /** The arm's own score: a rank inside that arm, never compared across arms. */
  score: number;
  arm: FindMatchArm;
  /** The alias of the term the glossary matched, on an `alias` candidate. */
  alias?: string;
  /** The record as its owner's read returned it, for a filter answering that read's own shape. */
  native?: unknown;
}

/** One arm's ranked list, and the weight its ranks take in the fusion. */
export interface ArmList {
  arm: FindMatchArm;
  hits: Candidate[];
}

export const hitId = (type: FindType, ref: string) => `${type}:${ref}`;
