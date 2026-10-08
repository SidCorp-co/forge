// The codes a conversation write is refused under, at REST and MCP alike (the refusal envelope).

import type { RefusalStatuses } from "./refusal.js";

export const CONVERSATION_REFUSAL_CODES = [
	"CONVERSATION_REFUSED",
	"CONVERSATION_UNADDRESSED",
	"CONVERSATION_PROJECT_CONFLICT",
	"CONVERSATION_ADAPTER_CONFLICT",
	"CONVERSATION_SHAPE_CONFLICT",
	"CONVERSATION_SCOPE_AMBIGUOUS",
	"CONVERSATION_SCOPE_FIXED",
	"CONVERSATION_NOT_WEB",
	"CONVERSATION_MODE_SETTLED",
	"CONVERSATION_BA_ASSISTANT_ONLY",
	"CONVERSATION_AGENT_NO_DEVICE",
	"ASSISTANT_MODEL_NOT_CONFIGURED",
	"CONVERSATION_ATTACHMENT_FOREIGN",
	"CONVERSATION_PAGE_OUT_OF_DATE",
	"CONVERSATION_TURN_HANDED_OFF",
	"CONVERSATION_TURN_ON_ANOTHER_CORE",
	"CONVERSATION_NOTHING_RUNNING",
	"CONVERSATION_LAST_HANDLE",
	"CONVERSATION_LAST_PERSON",
	"HANDLE_NOT_FOUND",
	"HANDLE_NOT_AN_AGENT",
	"HANDLE_HAS_NO_NAME",
	"HANDLE_NOT_ON_PROJECT",
	"PARTICIPANT_UNIDENTIFIED",
	"PARTICIPANT_KIND_TAKEN",
	"ECOSYSTEM_NOT_MEMBER",
	"INVALID_NAME",
	"EMPTY_FILE",
	"FILE_TOO_LARGE",
	"MIME_NOT_ALLOWED",
	"DOCUMENT_UNREADABLE",
] as const;

export type ConversationRefusalCode =
	(typeof CONVERSATION_REFUSAL_CODES)[number];

/**
 * No chat model is configured on this instance: nothing the caller sends can fix it (REQ-19). A
 * message from a page older than the contract is a request-shape refusal, under a code of its own so
 * the tab that sent it prints its sentence (ISS-441).
 */
export const CONVERSATION_REFUSAL_STATUSES = {
	ASSISTANT_MODEL_NOT_CONFIGURED: 503,
	CONVERSATION_PAGE_OUT_OF_DATE: 400,
} as const satisfies RefusalStatuses<ConversationRefusalCode>;

/**
 * Why a chat turn ended with no answer: the code a window records (decision unreachable) and the
 * status a reader is told names. A failure, never a silence the turn chose.
 */
export const ASSISTANT_TURN_FAILURE_CODES = [
	"ASSISTANT_TURN_TIMED_OUT",
	"ASSISTANT_TURN_FAILED",
] as const;

export type AssistantTurnFailureCode =
	(typeof ASSISTANT_TURN_FAILURE_CODES)[number];

export function isAssistantTurnFailureCode(
	code: unknown,
): code is AssistantTurnFailureCode {
	return (
		typeof code === "string" &&
		(ASSISTANT_TURN_FAILURE_CODES as readonly string[]).includes(code)
	);
}
