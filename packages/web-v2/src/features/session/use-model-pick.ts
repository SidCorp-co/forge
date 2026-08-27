"use client";

// The model picker's local pick, as a state machine of its own (ISS-718).
//
// It exists because the obvious version is wrong. `POST /api/agent-sessions/send`
// answers `{ok:true}`, not the session row, so the persisted `metadata.model`
// only arrives on the refetch that follows — and react-query serves the PREVIOUS
// row while that refetch is in flight. Clearing the pick when the send resolves
// therefore flips the trigger back to the old model for a round trip, and leaves
// the picker naming a model the session is not running if the refetch fails.

import { useEffect, useState } from "react";
import type { ModelTier } from "./types";

interface Pick {
  value: ModelTier | null;
  /** The pick has ridden a real send; only the confirming row is outstanding. */
  sent: boolean;
}

export interface ModelPick {
  /** `undefined` = untouched (show the persisted model); `null` = Default. */
  pendingModel: ModelTier | null | undefined;
  /** True only while the pick has not yet been carried by a send. */
  unsent: boolean;
  select: (value: ModelTier | null) => void;
  /** Mark the exact pick carried by a send after that send resolves. */
  markSent: (value: ModelTier | null | undefined) => void;
  /** Switching or starting a conversation drops the pick. */
  reset: () => void;
}

/**
 * Track the composer's model pick against the value the session has persisted.
 *
 * The pick is retired only once `persistedModel` actually reports it, so the
 * trigger never regresses to the previous model mid-refetch.
 */
export function useModelPick(persistedModel: ModelTier | null): ModelPick {
  const [pick, setPick] = useState<Pick | null>(null);

  useEffect(() => {
    if (pick?.sent && persistedModel === pick.value) setPick(null);
  }, [pick, persistedModel]);

  return {
    pendingModel: pick ? pick.value : undefined,
    unsent: !!pick && !pick.sent,
    select: (value) => setPick({ value, sent: false }),
    markSent: (value) =>
      setPick((p) => (p && !p.sent && p.value === value ? { ...p, sent: true } : p)),
    reset: () => setPick(null),
  };
}
