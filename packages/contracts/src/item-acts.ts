// The Product acts a person takes on an item's page that the chat makes for them on their word
// (REQ-69 BC-3, BC-4, BC-5): the model puts each in a set with `put_decision_set` (`acts`), core reads
// the item as the person and keeps the act it would make (the revision, the approval, the issues a
// cut takes), the reply says what each records where, and a later message of theirs agreeing the set
// makes it with `act_on_decisions`, through the act's own core door, as them. A chat never files an
// issue (BC-7): a triage that names or titles one is refused before the set is kept.

import { z } from "zod";
import { feedbackTriageSchema } from "./feedback.js";
import { REASON_TEXT_MAX } from "./reason-text.js";

/** The item kinds an act is made on, each the page it is done on. */
export const ITEM_ACT_KINDS = [
	"requirement",
	"feedback",
	"workflow",
	"release",
] as const;
export type ItemActKind = (typeof ITEM_ACT_KINDS)[number];

type ReasonRule = "none" | "optional" | "required";

/**
 * Every act a person takes on an item's page that the chat can make: the kind it is on, whether it
 * carries a reason (as the page's own form asks), and the label the set and its result read by.
 */
export const ITEM_ACTS = {
	"requirement.propose": {
		kind: "requirement",
		reason: "none",
		label: "Propose",
	},
	"requirement.agree": {
		kind: "requirement",
		reason: "required",
		label: "Agree",
	},
	"requirement.accept": {
		kind: "requirement",
		reason: "required",
		label: "Accept revision",
	},
	"requirement.return": {
		kind: "requirement",
		reason: "required",
		label: "Return revision",
	},
	"requirement.defer": {
		kind: "requirement",
		reason: "required",
		label: "Defer",
	},
	"requirement.undefer": {
		kind: "requirement",
		reason: "required",
		label: "Undefer",
	},
	"requirement.drop": {
		kind: "requirement",
		reason: "required",
		label: "Drop",
	},
	"requirement.accept_delivery": {
		kind: "requirement",
		reason: "optional",
		label: "Accept delivery",
	},
	"feedback.triage": { kind: "feedback", reason: "none", label: "Triage" },
	"workflow.propose": { kind: "workflow", reason: "none", label: "Propose" },
	"workflow.approve": {
		kind: "workflow",
		reason: "optional",
		label: "Approve",
	},
	"workflow.return": { kind: "workflow", reason: "required", label: "Return" },
	"release.cut": { kind: "release", reason: "none", label: "Cut" },
	"release.approve": {
		kind: "release",
		reason: "optional",
		label: "Approve",
	},
	"release.return": { kind: "release", reason: "required", label: "Return" },
} as const satisfies Record<
	string,
	{ kind: ItemActKind; reason: ReasonRule; label: string }
>;
export type ItemAct = keyof typeof ITEM_ACTS;
export const ITEM_ACT_NAMES = Object.keys(ITEM_ACTS) as [ItemAct, ...ItemAct[]];

/** The kind an act is on. */
export const itemActKind = (act: ItemAct): ItemActKind => ITEM_ACTS[act].kind;

/** Why an act could not be put in a set, each by its own name. */
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

/** The id a set and a refused act know an item act by: one per act on one item. */
export const itemActId = (act: ItemAct, key: string): string =>
	`act:${act}:${key.toUpperCase()}`;

/** What the model asks for: the act, the item's key, and what the act carries. */
export const itemActAskSchema = z.strictObject({
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
		.max(REASON_TEXT_MAX)
		.optional()
		.describe(
			"the person's reason, in the project's language; owed where the page asks for one",
		),
	triage: feedbackTriageSchema
		.optional()
		.describe(
			"feedback.triage only: the triage in the Feedback page's own shape; a chat names or titles no issue",
		),
});
export type ItemActAsk = z.infer<typeof itemActAskSchema>;

/** The act as core read it at put time, which the person's word later makes exactly. */
export const itemActPlanSchema = z.strictObject({
	act: z.enum(ITEM_ACT_NAMES),
	/** What the item's door is addressed by: its key, a workflow's uuid, a release's version. */
	ref: z.string(),
	/** The state the act was read against. */
	from: z.string(),
	/** The revision a requirement or workflow act names. */
	revision: z.number().int().positive().optional(),
	/** The issues a release cut carries. */
	issueIds: z.array(z.string()).optional(),
	triage: feedbackTriageSchema.optional(),
});
export type ItemActPlan = z.infer<typeof itemActPlanSchema>;
