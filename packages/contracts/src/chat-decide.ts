// The decisions the chat assistant makes for the person on their word (REQ-41 BC-24, BC-25, BC-27):
// told in their current message to act ("open them for me"), it answers exactly the Needs-you
// decisions the conversation agreed, as them and with their own access, and reports each item's
// state read back. Core refuses the call unless the person's words it quotes are in that message, so
// a decision is never made on the model's say-so; without that word the decision cards stay the way.
//
// The agreed set is core's, not the prompt's (judge K66 on dev.304, ISS-624): the chat puts a set to
// the person with `put_decision_set`, core keeps it, and "open them" in a later message acts on that
// set whole, so the model can neither widen nor narrow it. A decision the person names by its key in
// their current message is agreed by that message itself. A decision whose act was refused twice in
// the conversation is not offered again, and Forge's own feedback records it (BC-28).

import { z } from "zod";
import { itemActAskSchema, itemActPlanSchema } from "./item-acts.js";

/** The tool the model calls to make them. */
export const CHAT_DECIDE_TOOL = "act_on_decisions" as const;

/** The tool the model calls to put a set of decisions to the person for their agreement. */
export const CHAT_DECISION_SET_TOOL = "put_decision_set" as const;

export const CHAT_DECIDE_LIMITS = {
	word: 500,
	decisions: 20,
	reason: 1000,
} as const;

export const CHAT_DECIDE_REFUSAL_CODES = [
	"CHAT_DECIDE_INVALID",
	"CHAT_DECIDE_NO_WORD",
	/** The set named is not the newest one this conversation put to the person, or none was put. */
	"CHAT_DECIDE_SET_UNKNOWN",
	/** The set was put in this same turn: the person has not seen it, so nothing of theirs agreed it. */
	"CHAT_DECIDE_SET_UNSEEN",
	/** A set put to the person held a decision it may not hold; nothing was kept. */
	"CHAT_DECISION_SET_REFUSED",
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
	/** Named outside an agreed set and not by its key in the person's current message. */
	"DECISION_NOT_AGREED",
	/** Its act was refused twice in this conversation; it is not offered a third time (BC-28). */
	"DECISION_REFUSED_TWICE",
] as const;
export type ChatDecisionRefusalCode =
	(typeof CHAT_DECISION_REFUSAL_CODES)[number];

const decisionItemsSchema = z
	.array(
		z.strictObject({
			/** The decision's id from forge_needs_you, or the key of the item it opens (ISS-603). */
			decision: z.string().trim().min(1).max(300),
			/** The answer's id; left out, the recommended one. */
			answer: z.string().trim().min(1).max(200).optional(),
			/** The person's reason, for an answer that takes one. */
			reason: z
				.string()
				.trim()
				.min(1)
				.max(CHAT_DECIDE_LIMITS.reason)
				.optional(),
		}),
	)
	.min(1)
	.max(CHAT_DECIDE_LIMITS.decisions);

export const chatDecideParamsSchema = z
	.strictObject({
		/** The person's instruction to act, quoted exactly from their latest message. */
		word: z.string().trim().min(2).max(CHAT_DECIDE_LIMITS.word),
		/** The set `put_decision_set` put to the person in an earlier turn, which their word agrees: acted on whole. */
		set: z.uuid().optional(),
		/** Decisions the person names by their keys in their current message, where no set was put. */
		decisions: decisionItemsSchema.optional(),
	})
	.refine((p) => (p.set === undefined) !== (p.decisions === undefined), {
		message:
			"name exactly one of set (the set put to the person, which their word agrees) or decisions (the ones their current message names by key)",
		path: ["set"],
	});
export type ChatDecideParams = z.infer<typeof chatDecideParamsSchema>;

/**
 * What `put_decision_set` takes: the Needs-you decisions to put to the person, each as
 * `act_on_decisions` would make it, and the Product acts on items they asked for (REQ-69 BC-3), each
 * made through the act's own door once their word agrees the set.
 */
export const chatDecisionSetParamsSchema = z
	.strictObject({
		decisions: decisionItemsSchema.optional(),
		acts: z
			.array(itemActAskSchema)
			.min(1)
			.max(CHAT_DECIDE_LIMITS.decisions)
			.optional(),
	})
	.refine((p) => p.decisions !== undefined || p.acts !== undefined, {
		message:
			"name decisions (Needs-you decisions to answer), acts (Product acts on items), or both",
		path: ["decisions"],
	});

/** One decision of a set as core keeps it: the decision, its row's key, and the answer it gives. */
export const chatDecisionSetItemSchema = z.strictObject({
	/** The Needs-you decision id. */
	decision: z.string(),
	key: z.string(),
	/** The answer's id, and its label as the card shows it. */
	answer: z.string(),
	label: z.string(),
	reason: z.string().optional(),
	/** A Product act on an item (REQ-69), as core read it when the set was put; absent on a Needs-you decision. */
	act: itemActPlanSchema.optional(),
});
export type ChatDecisionSetItem = z.infer<typeof chatDecisionSetItemSchema>;

/** An item's state as read back after the act, or as it stood when it needed no act. */
export const chatItemStateSchema = z.strictObject({
	key: z.string(),
	status: z.string(),
	/** Who made the item's last move, by name; null where no move is recorded. */
	movedBy: z.string().nullable(),
	movedAt: z.string().nullable(),
});
export type ChatItemState = z.infer<typeof chatItemStateSchema>;

export const chatDecisionResultSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		outcome: z.literal("done"),
		decision: z.string(),
		/** The Needs-you decision id that was answered. */
		id: z.string(),
		answer: z.string(),
		state: chatItemStateSchema.nullable(),
	}),
	z.strictObject({
		outcome: z.literal("already_done"),
		decision: z.string(),
		state: chatItemStateSchema,
	}),
	z.strictObject({
		outcome: z.literal("refused"),
		decision: z.string(),
		code: z.enum(CHAT_DECISION_REFUSAL_CODES),
		detail: z.string(),
		/** What the person can do next, where the refusal leaves them a way on (REQ-69 BC-5). */
		next: z.string().optional(),
		state: chatItemStateSchema.nullable(),
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
 * What a decision card pressed under a chat reply tells the room it was pressed in (REQ-41 BC-24):
 * the decision and the item it opens, and whether the press went through. Core reads the item back
 * and posts its state as the follow-up, so "Sent" is never the last word; nothing the browser sends
 * is shown as written, only what core reads.
 */
const pressedCard = {
	/** The Needs-you decision id the card carried. */
	decision: z.string().trim().min(1).max(300),
	/** The row's key, as the card carried it: what a failure is counted on and named by. */
	key: z.string().trim().min(1).max(200),
	/** The item the decision opens, as the card carried it; null where it opens none. Never an issue (REQ-68 BC-6). */
	opens: z
		.strictObject({
			kind: z.enum(["requirement", "feedback"]),
			key: z
				.string()
				.trim()
				.regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/),
		})
		.nullable(),
};

export const DECISION_OUTCOME_LIMITS = { detail: 600 } as const;

/**
 * Why a press failed, as core refused it to the browser that pressed (ISS-624, judge K66: the
 * follow-up said "the card says why" and named no reason). `code` is the refusal's code, or
 * `HTTP_<status>` / `NETWORK` where none came back.
 */
export const decisionPressFailureSchema = z.strictObject({
	code: z
		.string()
		.trim()
		.regex(/^[A-Z][A-Z0-9_]{1,80}$/),
	detail: z.string().trim().min(1).max(DECISION_OUTCOME_LIMITS.detail),
});
export type DecisionPressFailure = z.infer<typeof decisionPressFailureSchema>;

export const decisionOutcomeRequestSchema = z.discriminatedUnion("ok", [
	z.strictObject({ ...pressedCard, ok: z.literal(true) }),
	z.strictObject({
		...pressedCard,
		ok: z.literal(false),
		failure: decisionPressFailureSchema,
	}),
]);
export type DecisionOutcomeRequest = z.infer<
	typeof decisionOutcomeRequestSchema
>;
export const DECISION_OUTCOME_SHAPE =
	"{ decision, key, opens: { kind, key } | null, ok: true } | { decision, key, opens, ok: false, failure: { code, detail } }" as const;
