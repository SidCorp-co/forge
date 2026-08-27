// The per-session model selection (ISS-718). One place decides what a valid
// model is and where a session remembers it, so the request schemas, the WS
// dispatch frames, and the regenerate/rerun re-publish paths cannot disagree
// about either.
//
// Empirically checked on claude 2.1.241 before this was built: a changed
// `--model` IS honoured on a `--resume` follow-up (haiku -> sonnet -> haiku all
// took effect on one session id, read back from `modelUsage`), and a resume
// with NO `--model` inherits whatever that session last ran on. So the web
// picker may present its choice as the session's active model — and core still
// sends the persisted value on every turn, because a migrated cold start on a
// different runner has no session file to inherit from.

import { z } from 'zod';
import { type ModelTier, modelTiers } from '../db/schema.js';

/** The tiers a caller may ask for — the `model_tier` DB enum, not a copy of it. */
export const modelTierSchema = z.enum(modelTiers);

/**
 * The session's remembered model, or null when it has none.
 *
 * `metadata.model` is written by {@link import('./chat-turn.js').dispatchChatTurn}
 * on an explicit pick and read back by every later turn. Anything that is not a
 * known tier — a legacy string, a number, a null — reads as "no selection"
 * rather than throwing: this runs on the dispatch path for every chat turn, and
 * one malformed jsonb row must not be able to wedge a conversation.
 */
export function readSessionModel(metadata: unknown): ModelTier | null {
  const value = (metadata as { model?: unknown } | null | undefined)?.model;
  const parsed = modelTierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
