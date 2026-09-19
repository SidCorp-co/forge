export type AnswerStyle = 'default' | 'concise' | 'detailed' | 'bullets';

export type AnswerInGroupMode = 'window' | 'mention' | 'tool';

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

export interface AgentSelfPatch {
  soul?: string | null;
  instructions?: string | null;
  emoji?: string | null;
  greeting?: string | null;
  presence?: Record<string, unknown>;
}

export type PreferenceChangeField = 'answer_style' | 'assistant_instructions';
export type PreferenceChangeActor = 'person' | 'admin' | 'assistant';

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
