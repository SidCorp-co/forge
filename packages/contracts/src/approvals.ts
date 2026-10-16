// The approval inbox (`GET /api/projects/:id/approvals`): every pending record of one project that
// waits on the viewer's approve-type decision, one row each, oldest first. A row says what it is,
// who asked and since when, and carries the acts that decide it: each the route the record's own
// page calls (`./needs-you-decisions.ts:DECISION_ACTS`), posted as the person who presses it, so the
// inbox decides nothing the record's page could not. A row is listed only where the viewer may
// decide it; a pending record somebody else decides is never shown here.

import { z } from "zod";
import { MOCKUP_KINDS } from "./mockups.js";
import { DECISION_ACT_NAMES } from "./needs-you-decisions.js";
import { SUGGESTION_KINDS } from "./suggestions.js";
import { cutAtWord } from "./title-text.js";

/**
 * What waits on an approve-type decision. `revision`: a requirement revision proposed for sign-off.
 * `agreement`: a requirement waiting to be agreed at its head. `design`: a workflow design revision
 * proposed for approval. `repin`: a moved base's pin-only dependents, re-pinned by one act on the
 * base's page. A contract version is Forge's upkeep (`./needs-you.ts:NEEDS_YOU_AREA_SPACE`), not a
 * person's ask, so it is not a kind here.
 */
export const APPROVAL_KINDS = [
	"suggestion",
	"mockup",
	"preview",
	"design",
	"repin",
	"revision",
	"agreement",
	"release",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Who asked: a person, an agent's credential, or the assistant on a person's behalf. */
export const APPROVAL_ASKERS = ["person", "agent", "assistant"] as const;
export type ApprovalAsker = (typeof APPROVAL_ASKERS)[number];

/** The pages a row opens on. */
export const APPROVAL_OPENS = [
	"requirement",
	"feedback",
	"issue",
	"workflow",
	"release",
] as const;

const LIMITS = { title: 500, key: 200, items: 300 } as const;

/**
 * What an act does with a reason: `required` refuses an empty one (a return, a reject), `optional`
 * keeps one where it is given (an accept's authority, an approver's note), `none` reads none, so a
 * page never asks for words the route would drop.
 */
export const APPROVAL_REASONS = ["required", "optional", "none"] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

/** The acts whose route reads no `reason`: an issue preview's approve takes no body. */
export const REASONLESS_ACTS: ReadonlySet<string> = new Set(["preview.approve"]);

/** One act a row's button performs: its body posted to its filled path. */
export const approvalActSchema = z.strictObject({
	act: z.enum(DECISION_ACT_NAMES),
	path: z
		.string()
		.startsWith("/api/")
		.refine((p) => !p.includes("/:"), {
			message: "an approval act's path has every param filled",
		}),
	body: z.record(z.string(), z.unknown()).nullable(),
	/** Whether the person types a reason, sent as the body's `reason`, before the post leaves. */
	reason: z.enum(APPROVAL_REASONS),
});
export type ApprovalAct = z.infer<typeof approvalActSchema>;

export const approvalItemSchema = z
	.strictObject({
		kind: z.enum(APPROVAL_KINDS),
		/** Unique within the inbox: the kind and the record's own id. */
		id: z.string().min(1).max(300),
		/** What a reader calls it: MK-n, REQ-n, a design's flow, a release version, the issue a preview serves, the record a suggestion is on. */
		key: z.string().min(1).max(LIMITS.key),
		/**
		 * The record's short title, never a prose field: a requirement's short name or title, the title
		 * of the record a suggestion is on, a design's title, a release's name, a mockup's name, the
		 * issue a preview serves; empty where the record has none. Cut by {@link approvalTitle}.
		 */
		title: z.string().max(LIMITS.title),
		/** A suggestion's kind; null on every other row. */
		suggestionKind: z.enum(SUGGESTION_KINDS).nullable(),
		/** A mockup's kind; null on every other row. */
		mockupKind: z.enum(MOCKUP_KINDS).nullable(),
		/** The revision a revision, agreement or design row decides; null on the rest. */
		revision: z.int().min(1).nullable(),
		/** Null where no record keeps who asked. */
		askedBy: z
			.strictObject({
				kind: z.enum(APPROVAL_ASKERS),
				/** The person, or the person the assistant answered; null where the account is gone. */
				name: z.string().min(1).max(200).nullable(),
			})
			.nullable(),
		/** When it was asked: the proposal, the request, the preview going live. */
		since: z.iso.datetime().nullable(),
		opens: z
			.strictObject({
				kind: z.enum(APPROVAL_OPENS),
				key: z.string().min(1).max(LIMITS.key),
			})
			.nullable(),
		approve: approvalActSchema.nullable(),
		decline: approvalActSchema.nullable(),
	})
	.superRefine((item, ctx) => {
		if (!item.approve && !item.opens) {
			ctx.addIssue({
				code: "custom",
				path: ["approve"],
				message:
					"an approval row is decided here or opens the page that decides it, never neither",
			});
		}
		if (item.decline && item.decline.reason !== "required") {
			ctx.addIssue({
				code: "custom",
				path: ["decline", "reason"],
				message: "a decline carries the reason its asker reads",
			});
		}
	});
export type ApprovalItem = z.infer<typeof approvalItemSchema>;

/**
 * A pending record the read could not make a row of: listed by name, so it is seen and opened on its
 * own page, never dropped from the inbox and never the reason the rest of it fails.
 */
export const approvalUnreadableSchema = z.strictObject({
	kind: z.enum(APPROVAL_KINDS),
	/** The kind and the record's own id, as a row's `id` would be. */
	id: z.string().min(1).max(300),
	key: z.string().min(1).max(LIMITS.key),
	opens: z
		.strictObject({
			kind: z.enum(APPROVAL_OPENS),
			key: z.string().min(1).max(LIMITS.key),
		})
		.nullable(),
	/** What could not be read: each field and the rule it broke, in words. */
	problem: z.string().min(1).max(1000),
});
export type ApprovalUnreadable = z.infer<typeof approvalUnreadableSchema>;

export const approvalInboxSchema = z.strictObject({
	generatedAt: z.iso.datetime(),
	/** Oldest first, so what has waited longest leads; the first `LIMITS.items`. */
	items: z.array(approvalItemSchema).max(LIMITS.items),
	/** The pending records no row could be made of; the first `LIMITS.items`. */
	unreadable: z.array(approvalUnreadableSchema).max(LIMITS.items),
	/** How many records wait in all, readable or not; the nav's count. */
	total: z.int().min(0),
});
export type ApprovalInbox = z.infer<typeof approvalInboxSchema>;

export const APPROVAL_INBOX_MAX = LIMITS.items;

/** A record's title as its row shows it: cut at a whole word to the row's bound. */
export const approvalTitle = (title: string): string => cutAtWord(title, LIMITS.title);

/** Oldest first; a row with no time last, then by id so the order is total. */
export function byWaitedLongest(a: ApprovalItem, b: ApprovalItem): number {
	if (a.since !== b.since) {
		if (a.since === null) return 1;
		if (b.since === null) return -1;
		return a.since.localeCompare(b.since);
	}
	return a.id.localeCompare(b.id);
}
