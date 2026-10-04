// The codes an agent session, its turns and its attachments are refused by, in the refusal envelope.
import type { RefusalStatuses } from "./refusal.js";

export const AGENT_SESSION_REFUSAL_CODES = [
	"AGENT_SESSION_REFUSED",
	"SESSION_RUNNING",
	"SESSION_BUSY",
	"SESSION_STALE",
	"SESSION_CANCELLED",
	"SESSION_TERMINATED",
	"SESSION_OWNER_FORBIDDEN",
	"AGENT_CHAT_OWNER_FORBIDDEN",
	"TURN_STALE",
	"TURN_NOT_USER",
	"NO_PROMPT",
	"NO_DISPATCHABLE_PROMPT",
	"SEQ_TAKEN_BY_CORE",
	"NO_CLAUDE_CLIENT",
	"CHECKOUT_UNBOUND",
	"RUNNER_OUTDATED",
	"NO_LIVE_SESSION",
	"SESSION_PARKED",
	"NO_DEVICE",
] as const;

export type AgentSessionRefusalCode = (typeof AGENT_SESSION_REFUSAL_CODES)[number];
export const AGENT_SESSION_REFUSAL_STATUSES = {
	SESSION_STALE: 409,
	TURN_STALE: 409,
	SEQ_TAKEN_BY_CORE: 409,
} as const satisfies RefusalStatuses<AgentSessionRefusalCode>;
