// What a running agent-session turn is producing right now (ISS-1268): the items a box posts to
// `POST /api/agent-sessions/:id/live` and core fans out, unstored, as the `agent-session.live`
// frame. The runner reads them off Claude Code's stream-json (`runner-agent/src/chat_live.rs`); a
// view folds them into the turn it shows, and the stored transcript replaces them once it lands.

import { z } from "zod";

const parent = z.string().min(1).nullable();

/** One live item. Text and thinking under a `parent` belong to the subagent that call spawned. */
export const agentSessionLiveItemSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("message"), id: z.string().min(1).nullable(), parent }),
	z.strictObject({ kind: z.literal("messageEnd"), id: z.string().min(1).nullable(), parent }),
	z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(64_000), parent }),
	z.strictObject({ kind: z.literal("thinking"), text: z.string().min(1).max(64_000), parent }),
	/** `system/status`: the request in flight, a compaction running, or neither. */
	z.strictObject({ kind: z.literal("status"), status: z.enum(["requesting", "compacting"]).nullable() }),
	/** `system/api_retry`: the request failed and is tried again after `delayMs`. */
	z.strictObject({
		kind: z.literal("retry"),
		attempt: z.number().int().min(0),
		maxRetries: z.number().int().min(0),
		delayMs: z.number().int().min(0),
		errorStatus: z.number().int().nullable(),
	}),
	/** `system/compact_boundary`: the context was summarised from `preTokens` down. */
	z.strictObject({
		kind: z.literal("compacted"),
		trigger: z.enum(["manual", "auto"]),
		preTokens: z.number().int().min(0),
		postTokens: z.number().int().min(0).nullable(),
	}),
	/** `rate_limit_event` that is not `allowed`: held back until `resetsAt` (unix seconds). */
	z.strictObject({
		kind: z.literal("rateLimit"),
		status: z.string().min(1),
		resetsAt: z.number().int().nullable(),
		limit: z.string().nullable(),
	}),
	/** The context the session fills (`used`) and holds (`window`), each where the stream said it. */
	z.strictObject({
		kind: z.literal("context"),
		used: z.number().int().min(0).nullable(),
		window: z.number().int().min(1).nullable(),
	}),
	/** The turn's `result`: it ended, and why (`terminal_reason`). */
	z.strictObject({ kind: z.literal("ended"), reason: z.string().nullable() }),
	/** `prompt_suggestion`: the next prompt Claude Code predicts, after the turn. */
	z.strictObject({ kind: z.literal("suggestion"), text: z.string().min(1).max(2_000) }),
]);

export type AgentSessionLiveItem = z.infer<typeof agentSessionLiveItemSchema>;

/** At most this many items in one post; the runner sends a few a tick. */
export const AGENT_SESSION_LIVE_MAX_ITEMS = 200;

export const agentSessionLiveBatchSchema = z.strictObject({
	items: z.array(agentSessionLiveItemSchema).min(1).max(AGENT_SESSION_LIVE_MAX_ITEMS),
});

/** The `agent-session.live` frame: a session's live items, for the views reading it now. */
export interface AgentSessionLiveFrame {
	sessionId: string;
	projectId: string;
	/** Set where the session answers a room's turn; only that turn's asker is sent its text. */
	conversationId: string | null;
	items: AgentSessionLiveItem[];
}
