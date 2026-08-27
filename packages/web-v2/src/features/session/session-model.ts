// Reading the session's picked model back off its metadata (ISS-718).

// cm:edge contract -> packages/core/src/agent-sessions/session-model.ts — the same guard on the same jsonb key; a client that trusted the raw value would label the picker with a tier core refuses to dispatch, which is the one thing the picker must never do
import type { SessionMetadata } from "@/features/sessions/types";
import { type ModelTier, MODEL_TIER_LABELS } from "./types";

/**
 * The tier a session is running on, or null when it has never been picked (the
 * runner's own default). Anything that is not a known tier — a legacy string, a
 * number — reads as null rather than being shown, exactly as core reads it.
 */
export function readSessionModel(metadata: SessionMetadata | null | undefined): ModelTier | null {
  const value = metadata?.model;
  if (typeof value !== "string") return null;
  // cm:why Object.hasOwn, not `in` — `in` walks the prototype chain, so `"toString"` reads as a valid tier and labels the picker with it
  return Object.hasOwn(MODEL_TIER_LABELS, value) ? (value as ModelTier) : null;
}
