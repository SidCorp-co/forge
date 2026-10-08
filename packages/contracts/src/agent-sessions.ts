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
	"CONVERSATION_TURN_ASKER_ONLY",
	"TURN_STALE",
	"TURN_NOT_USER",
	"NO_PROMPT",
	"NO_DISPATCHABLE_PROMPT",
	"SEQ_TAKEN_BY_CORE",
	"NO_CLAUDE_CLIENT",
	"CHECKOUT_UNBOUND",
	"RUNNER_OUTDATED",
	"BOX_CANNOT_CONFINE_CHAT",
	"NO_LIVE_SESSION",
	"SESSION_PARKED",
	"NO_DEVICE",
	"SEND_SEQ_UNKNOWN",
	"SEND_ALREADY_SETTLED",
	"ATTACHMENT_NOT_IN_SESSION",
	"SESSION_METADATA_CORE_OWNED",
] as const;

export type AgentSessionRefusalCode = (typeof AGENT_SESSION_REFUSAL_CODES)[number];
export const AGENT_SESSION_REFUSAL_STATUSES = {
	SESSION_STALE: 409,
	TURN_STALE: 409,
	SEQ_TAKEN_BY_CORE: 409,
	SESSION_CANCELLED: 409,
	SEND_SEQ_UNKNOWN: 404,
	SEND_ALREADY_SETTLED: 409,
	CONVERSATION_TURN_ASKER_ONLY: 403,
} as const satisfies RefusalStatuses<AgentSessionRefusalCode>;

/** The metadata key a session carries when its answer belongs to a conversation turn. */
export const CONVERSATION_AGENT_MARKER = "conversationAgent";

/** Who asked, as a session's metadata carries it so a failover can mint again. */
export interface SessionAsker {
	userId: string;
	viaTokenId: string | null;
}

export function readSessionAsker(raw: unknown): SessionAsker | null {
	const m = raw as { userId?: unknown; viaTokenId?: unknown } | null;
	if (!m || typeof m.userId !== "string") return null;
	return {
		userId: m.userId,
		viaTokenId: typeof m.viaTokenId === "string" ? m.viaTokenId : null,
	};
}

/** `agent_sessions.kind` of a box's standing master session. */
export const MASTER_SESSION_KIND = "master";
/** `agent_sessions.kind` of a run a master declared on its box. */
export const RUN_SESSION_KIND = "run_session";
export const RUN_ISSUES_METADATA_KEY = "runIssues";
export const RUN_GROUP_METADATA_KEY = "runGroup";
export const RUN_ISSUE_STATUSES_METADATA_KEY = "runIssueStatuses";
