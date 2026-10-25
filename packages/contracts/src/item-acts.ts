// A Product act on an item the chat assistant offers rather than takes (REQ-69 BC-3, BC-4): the model
// names it, core reads the item as the person and checks the act is one the item's state allows and
// one the person may take there, and the browser draws it as a card that says what pressing does.
// Nothing changes until the person presses it; then it runs as them, through the same route the
// item's own page calls, which checks both again. After the press the card shows the item's new
// state, or why it failed and what to do next (BC-5). A chat never files an issue (BC-7): a triage
// that would file one is refused here, before any card is drawn.

import { z } from "zod";
import { FEEDBACK_LIMITS, FEEDBACK_TRIAGE_ROUTES } from "./feedback.js";
import { REASON_LINE_MAX } from "./reason-text.js";

/** The tool the model calls to offer one. */
export const ITEM_ACT_TOOL = "offer_item_act" as const;

/** The item kinds an act is offered on, each the page it is done on. */
export const ITEM_ACT_KINDS = [
	"requirement",
	"feedback",
	"workflow",
	"release",
] as const;
export type ItemActKind = (typeof ITEM_ACT_KINDS)[number];

type ReasonRule = "none" | "optional" | "required";

/**
 * Every act a person takes on an item's page that the chat can offer, with the kind it is on and
 * whether it carries a reason, as the page's own form asks.
 */
export const ITEM_ACTS = {
	"requirement.propose": { kind: "requirement", reason: "none" },
	"requirement.agree": { kind: "requirement", reason: "required" },
	"requirement.accept": { kind: "requirement", reason: "optional" },
	"requirement.return": { kind: "requirement", reason: "required" },
	"requirement.defer": { kind: "requirement", reason: "required" },
	"requirement.undefer": { kind: "requirement", reason: "required" },
	"requirement.drop": { kind: "requirement", reason: "required" },
	"requirement.accept_delivery": { kind: "requirement", reason: "optional" },
	"feedback.triage": { kind: "feedback", reason: "none" },
	"workflow.propose": { kind: "workflow", reason: "none" },
	"workflow.approve": { kind: "workflow", reason: "optional" },
	"workflow.return": { kind: "workflow", reason: "required" },
	"release.cut": { kind: "release", reason: "none" },
	"release.approve": { kind: "release", reason: "required" },
	"release.return": { kind: "release", reason: "required" },
} as const satisfies Record<string, { kind: ItemActKind; reason: ReasonRule }>;
export type ItemAct = keyof typeof ITEM_ACTS;
export const ITEM_ACT_NAMES = Object.keys(ITEM_ACTS) as [ItemAct, ...ItemAct[]];

/** The kind an act is on. */
export const itemActKind = (act: ItemAct): ItemActKind => ITEM_ACTS[act].kind;

export const ITEM_ACT_REFUSAL_CODES = [
	"ITEM_ACT_INVALID",
	"ITEM_ACT_UNKNOWN_ITEM",
	"ITEM_ACT_NOT_FROM_STATE",
	"ITEM_ACT_FORBIDDEN",
	"ITEM_ACT_REASON_REQUIRED",
	"ITEM_ACT_FILES_ISSUE",
	"ITEM_ACT_NOT_IN_PROJECT_LANGUAGE",
] as const;
export type ItemActRefusalCode = (typeof ITEM_ACT_REFUSAL_CODES)[number];

/** The triage routes a chat offers: every route the Feedback page takes but the revision route,
 *  which carries a suggestion only that page shows. */
export const ITEM_ACT_TRIAGE_ROUTES = FEEDBACK_TRIAGE_ROUTES.filter(
	(r) => r !== "revision",
) as Exclude<(typeof FEEDBACK_TRIAGE_ROUTES)[number], "revision">[];

const KEY = /^[A-Z][A-Z0-9]*-\d{1,9}$/;
const ISSUE_KEY = z.string().regex(KEY, "an issue key such as ISS-47");

/** What the model sends: the act, the item's key, and what the act carries. */
export const itemActParamsSchema = z.strictObject({
	act: z.enum(ITEM_ACT_NAMES),
	key: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe(
			"the item: REQ-n, FB-n, a workflow's flow such as chat-turn, or a release version such as 0.4.0-dev.217",
		),
	reason: z
		.string()
		.trim()
		.min(1)
		.max(REASON_LINE_MAX)
		.optional()
		.describe("the person's reason, in the project's language"),
	route: z
		.enum(ITEM_ACT_TRIAGE_ROUTES as [string, ...string[]])
		.optional()
		.describe("feedback.triage only: where the feedback goes"),
	issue: ISSUE_KEY.optional().describe(
		"feedback.triage route issue: the existing issue that carries it",
	),
	requirement: z
		.string()
		.regex(/^REQ-\d{1,9}$/, "a requirement key such as REQ-30")
		.optional()
		.describe("feedback.triage route new_requirement: the draft it joins"),
	title: z
		.string()
		.trim()
		.min(1)
		.max(FEEDBACK_LIMITS.title)
		.optional()
		.describe(
			"feedback.triage route new_requirement: the title of the draft it starts",
		),
	answer: z
		.string()
		.trim()
		.min(1)
		.max(FEEDBACK_LIMITS.answer)
		.optional()
		.describe("feedback.triage route answer: the answer the reporter is told"),
	duplicateOf: z
		.string()
		.regex(/^FB-\d{1,9}$/, "a feedback key such as FB-12")
		.optional()
		.describe("feedback.triage route duplicate: the feedback it repeats"),
	note: z
		.string()
		.trim()
		.min(1)
		.max(FEEDBACK_LIMITS.reason)
		.optional()
		.describe("feedback.triage: the note it carries; for decline, its reason"),
});
export type ItemActParams = z.infer<typeof itemActParamsSchema>;

/** The triage a card presses, in the Feedback route's own shape (`feedbackTriageSchema`). */
export const itemActTriageSchema = z.strictObject({
	route: z.enum(ITEM_ACT_TRIAGE_ROUTES as [string, ...string[]]),
	issue: z.string().optional(),
	requirement: z.string().optional(),
	title: z.string().optional(),
	answer: z.string().optional(),
	duplicateOf: z.string().optional(),
	note: z.string().optional(),
});
export type ItemActTriage = z.infer<typeof itemActTriageSchema>;

export const itemActOfferSchema = z.strictObject({
	v: z.literal(1),
	act: z.enum(ITEM_ACT_NAMES),
	projectId: z.uuid(),
	key: z.string(),
	/** What the item's route is addressed by: its key, a workflow's uuid, a release's version. */
	ref: z.string(),
	title: z.string(),
	/** The state the offer was read against; a card whose item has moved since offers nothing. */
	from: z.string(),
	/** The revision a requirement or workflow act names. */
	revision: z.number().int().positive().optional(),
	/** The release attempt and the approval a release decision answers. */
	runId: z.uuid().optional(),
	approvalId: z.uuid().optional(),
	/** The issues a release cut carries, by id and by key. */
	issueIds: z.array(z.uuid()).optional(),
	issueKeys: z.array(z.string()).optional(),
	reason: z.string().optional(),
	triage: itemActTriageSchema.optional(),
});
export type ItemActOffer = z.infer<typeof itemActOfferSchema>;

/** The offer a tool result carries, or null where the result is not one. */
export function readItemActOffer(resultText: string): ItemActOffer | null {
	try {
		const body = JSON.parse(resultText) as { offer?: unknown };
		const parsed = itemActOfferSchema.safeParse(body.offer);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
