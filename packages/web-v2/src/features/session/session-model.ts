// Reading the session's picked model back off its metadata (ISS-718).

// cm:edge contract -> packages/core/src/agent-sessions/session-model.ts — `default` remains a UI Default label while only DB tiers map to tier labels, so a raw jsonb value cannot make the picker offer a model core refuses
import type { SessionMetadata } from "@/features/sessions/types";
import { type ModelTier, MODEL_TIER_LABELS } from "./types";

/**
 * The tier a session is running on, or null when it has never been picked or
 * explicitly selected Claude Code's Default. Anything that is not a known tier
 * reads as null rather than being shown.
 */
export function readSessionModel(metadata: SessionMetadata | null | undefined): ModelTier | null {
  const value = metadata?.model;
  if (typeof value !== "string") return null;
  // cm:why Object.hasOwn, not `in` — `in` walks the prototype chain, so `"toString"` reads as a valid tier and labels the picker with it
  return Object.hasOwn(MODEL_TIER_LABELS, value) ? (value as ModelTier) : null;
}
