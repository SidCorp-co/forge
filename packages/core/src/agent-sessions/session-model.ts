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

export const sessionModelSchema = z.union([modelTierSchema, z.literal('default')]);

export type SessionModel = ModelTier | 'default';

/**
 * The session's remembered model, or null when it has none.
 *
 * `metadata.model` is written by {@link import('./chat-turn.js').dispatchChatTurn}
 * on an explicit pick and read back by every later turn. `default` is a Claude
 * Code control value rather than a DB tier; it must survive a resumed turn so
 * the CLI clears its restored model instead of inheriting it. Anything else
 * reads as "no selection" rather than throwing, so malformed jsonb cannot
 * wedge a conversation.
 */
export function readSessionModel(metadata: unknown): SessionModel | null {
  const value = (metadata as { model?: unknown } | null | undefined)?.model;
  const parsed = sessionModelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
