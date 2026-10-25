// The decisions the chat assistant makes for the person on their word (REQ-41 BC-24, BC-25, BC-27):
// told in their current message to act ("open them for me"), it answers exactly the Needs-you
// decisions the conversation agreed, as them and with their own access, and reports each item's
// state read back. Core refuses the call unless the person's words it quotes are in that message, so
// a decision is never made on the model's say-so; without that word the decision cards stay the way.

import { z } from "zod";

/** The tool the model calls to make them. */
export const CHAT_DECIDE_TOOL = "act_on_decisions" as const;

export const CHAT_DECIDE_LIMITS = { word: 500, decisions: 20, reason: 1000 } as const;

export const CHAT_DECIDE_REFUSAL_CODES = [
	"CHAT_DECIDE_INVALID",
	"CHAT_DECIDE_NO_WORD",
] as const;
export type ChatDecideRefusalCode = (typeof CHAT_DECIDE_REFUSAL_CODES)[number];

/** Why one decision of the call was not made, each item refused by its own name. */
export const CHAT_DECISION_REFUSAL_CODES = [
	"DECISION_UNKNOWN",
	"DECISION_AMBIGUOUS",
	"DECISION_ANSWER_UNKNOWN",
	"DECISION_NO_RECOMMENDATION",
	"DECISION_REASON_REQUIRED",
	"DECISION_ACT_ON_ITS_PAGE",
	"DECISION_REFUSED",
	/** Named in neither the person's latest message nor the reply they answered: not in the set they agreed. */
	"DECISION_NOT_AGREED",
	/** Refused twice in this conversation already, from a card or from chat: a third try would fail the same way. */
	"DECISION_REFUSED_TWICE",
] as const;
export type ChatDecisionRefusalCode =
	(typeof CHAT_DECISION_REFUSAL_CODES)[number];

export const chatDecideParamsSchema = z.strictObject({
	/** The person's instruction to act, quoted exactly from their latest message. */
	word: z.string().trim().min(2).max(CHAT_DECIDE_LIMITS.word),
	decisions: z
		.array(
			z.strictObject({
				/** The decision's id from forge_needs_you, or the key of the item it opens (ISS-603). */
				decision: z.string().trim().min(1).max(300),
				/** The answer's id; left out, the recommended one. */
				answer: z.string().trim().min(1).max(200).optional(),
				/** The person's reason, for an answer that takes one. */
				reason: z.string().trim().min(1).max(CHAT_DECIDE_LIMITS.reason).optional(),
			}),
		)
		.min(1)
		.max(CHAT_DECIDE_LIMITS.decisions),
});
export type ChatDecideParams = z.infer<typeof chatDecideParamsSchema>;

/** An item's state as read back after the act, or as it stood when it needed no act. */
export const chatItemStateSchema = z.strictObject({
	key: z.string(),
	status: z.string(),
	/** Who made the item's last move, by name; null where no move is recorded. */
	movedBy: z.string().nullable(),
	movedAt: z.string().nullable(),
});
export type ChatItemState = z.infer<typeof chatItemStateSchema>;

/**
 * The sentence core writes for one item, which the reply relays as written: the model reports
 * nothing of its own. Absent on a result a turn stored before core wrote one.
 */
const said = z.string().optional();

export const chatDecisionResultSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("done"),
		decision: z.string(),
		/** The Needs-you decision id that was answered. */
		id: z.string(),
		answer: z.string(),
		state: chatItemStateSchema.nullable(),
		said,
	}),
	z.strictObject({
		outcome: z.literal("already_done"),
		decision: z.string(),
		state: chatItemStateSchema,
		said,
	}),
	z.strictObject({
		outcome: z.literal("refused"),
		decision: z.string(),
		code: z.enum(CHAT_DECISION_REFUSAL_CODES),
		detail: z.string(),
		state: chatItemStateSchema.nullable(),
		said,
	}),
]);
export type ChatDecisionResult = z.infer<typeof chatDecisionResultSchema>;

export const chatDecideResultSchema = z.strictObject({
	results: z.array(chatDecisionResultSchema),
	note: z.string(),
});
export type ChatDecideResult = z.infer<typeof chatDecideResultSchema>;

/** The result a tool call carries, or null where it is not one. */
export function readChatDecideResult(text: string): ChatDecideResult | null {
	try {
		const parsed = chatDecideResultSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * The block a failed card press is kept by on its follow-up, so the conversation holds every refused
 * decision, from a card or from chat, and a third try on the same item is refused (REQ-41 BC-28).
 */
export const CHAT_DECISION_CARD_BLOCK = "decision_card" as const;

/** A refusal as the route that refused a press named it: its code, and its one sentence. */
export const decisionRefusalSchema = z.strictObject({
	code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/, "a refusal code, upper case and underscores"),
	detail: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.regex(/^[^\r\n]*$/, "one line: no line break"),
});
export type DecisionRefusal = z.infer<typeof decisionRefusalSchema>;

/**
 * What a decision card pressed under a chat reply tells the room it was pressed in (REQ-41 BC-24):
 * the decision and the item it opens, whether the press went through, and, where it did not, the
 * refusal its route answered with. Core reads the item back and posts its state as the follow-up,
 * with why a failed press failed and what to do next, so "Sent" is never the last word.
 */
export const decisionOutcomeRequestSchema = z.strictObject({
	/** The Needs-you decision id the card carried. */
	decision: z.string().trim().min(1).max(300),
	/** The item the decision opens, as the card carried it; null where it opens none. */
	opens: z
		.strictObject({
			kind: z.enum(["issue", "requirement", "feedback"]),
			key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
		})
		.nullable(),
	ok: z.boolean(),
	/** The refusal a failed press got; null on one that went through. */
	refusal: decisionRefusalSchema.nullable(),
}).refine((r) => r.ok === (r.refusal === null), {
	path: ["refusal"],
	message: "a press that went through carries no refusal, and one that failed carries the one its route answered",
});
export type DecisionOutcomeRequest = z.infer<typeof decisionOutcomeRequestSchema>;
export const DECISION_OUTCOME_SHAPE =
	"{ decision, opens: { kind, key } | null, ok, refusal: { code, detail } | null }" as const;
