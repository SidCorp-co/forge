/**
 * ISS-1034 — the assistant's self, a person's answer preferences, and the
 * trail every preference write leaves: the wire shapes both apps read.
 *
 * Types only. Core owns the runtime values (its Drizzle enums and zod schemas)
 * and imports nothing from here at runtime.
 */

export type AnswerStyle = "default" | "concise" | "detailed" | "bullets";

export type AnswerInGroupMode = "window" | "mention";

/** What an admin may set about when an agent speaks; every key optional, unset folds to the default. */
export interface PresenceConfig {
  dormantMs?: number;
  backoffAfter?: number;
  loopBounceMs?: number;
  loopLimit?: number;
  answerInGroup?: AnswerInGroupMode;
  heartbeat?: { enabled?: boolean; intervalMs?: number };
}

/** `GET /api/orgs/:orgId/agents/:agentUserId/self`. */
export interface AgentSelf {
  userId: string;
  soul: string | null;
  instructions: string | null;
  emoji: string | null;
  greeting: string | null;
  presence: PresenceConfig;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** `PATCH /api/orgs/:orgId/agents/:agentUserId/self` — any subset; `null` clears; a presence key set to `null` unsets it. */
export interface AgentSelfPatch {
  soul?: string | null;
  instructions?: string | null;
  emoji?: string | null;
  greeting?: string | null;
  presence?: Record<string, unknown>;
}

export type PreferenceChangeField = "answer_style" | "assistant_instructions";
export type PreferenceChangeActor = "person" | "admin" | "assistant";

/** One row of `GET /api/auth/me/preferences/changes`. */
export interface PreferenceChange {
  id: string;
  userId: string;
  field: PreferenceChangeField;
  previousValue: string | null;
  newValue: string | null;
  changedBy: PreferenceChangeActor;
  changedByUserId: string | null;
  conversationId: string | null;
  changedAt: string;
}
