// An act on an issue the chat assistant offers rather than takes: the model names it, core checks
// it is a move the issue's status allows and one the person asking holds the permission for, and
// the browser draws it as a button. Nothing changes until the person presses it, and then it runs
// as them, through the same route the issue page uses (chat mining 2026-10-07: 30 asks to run,
// continue or close an issue met 38 replies saying chat cannot).

import { z } from "zod";
import { ISSUE_STATUSES } from "./issue-machine.js";

/** The tool the model calls to offer one. */
export const CHAT_ACT_TOOL = "offer_act" as const;

export const CHAT_ACTS = ["run", "continue", "drop", "release"] as const;
export type ChatAct = (typeof CHAT_ACTS)[number];

/** What pressing the button does: the route the issue page would call. */
export const CHAT_ACT_EFFECTS = [
	"admit",
	"run-step",
	"transition",
	"release",
] as const;
export type ChatActEffect = (typeof CHAT_ACT_EFFECTS)[number];

export const CHAT_ACT_REFUSAL_CODES = [
	"CHAT_ACT_INVALID",
	"CHAT_ACT_NOT_FROM_STATUS",
	"CHAT_ACT_FORBIDDEN",
	"CHAT_ACT_REASON_REQUIRED",
	"CHAT_ACT_ISSUE_UNKNOWN",
] as const;
export type ChatActRefusalCode = (typeof CHAT_ACT_REFUSAL_CODES)[number];

export const chatActParamsSchema = z.strictObject({
	act: z.enum(CHAT_ACTS),
	issue: z
		.string()
		.regex(/^[A-Z][A-Z0-9]*-\d+$/, "an issue key such as ISS-47"),
	reason: z.string().trim().min(1).max(500).optional(),
});
export type ChatActParams = z.infer<typeof chatActParamsSchema>;

export const chatActOfferSchema = z.strictObject({
	v: z.literal(1),
	act: z.enum(CHAT_ACTS),
	effect: z.enum(CHAT_ACT_EFFECTS),
	projectId: z.string().uuid(),
	issueId: z.string().uuid(),
	key: z.string(),
	title: z.string(),
	/** The status the offer was made against; a card whose issue has moved since offers nothing. */
	from: z.enum(ISSUE_STATUSES),
	/** The status a transition lands in; absent for a run step and a release. */
	to: z.enum(ISSUE_STATUSES).optional(),
	reason: z.string().optional(),
});
export type ChatActOffer = z.infer<typeof chatActOfferSchema>;

/** The offer a tool result carries, or null where the result is not one. */
export function readChatActOffer(resultText: string): ChatActOffer | null {
	try {
		const body = JSON.parse(resultText) as { offer?: unknown };
		const parsed = chatActOfferSchema.safeParse(body.offer);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
