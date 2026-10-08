// A chat's write is a proposal until the person it answers agrees (REQ-30 BC-4, workflow chat-turn
// steps restate, confirm, write). Core holds the call the model or an Agent session made instead
// of running it, the conversation shows it as a confirm card, and the person agrees by pressing
// Record it on that card, from their own sign-in. A typed reply agrees to nothing, whatever it says:
// only then does core make that exact call, as that person.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

/** What a proposal would write, as the card names it. */
export const CHAT_PROPOSAL_KINDS = [
	"feedback",
	"requirement_draft",
	"requirement_revision",
	"comment",
	"attachment",
	"memory_note",
	"preferences",
	"report_save",
	"issue_change",
	"requirement_link",
	"project_change",
] as const;
export type ChatProposalKind = (typeof CHAT_PROPOSAL_KINDS)[number];

/**
 * pending: waiting on the person. agreed: they agreed and the write is being made. recorded: it was
 * made. failed: they agreed and the write was refused (their access, the record's state), so nothing
 * was written. declined: they declined, and nothing was written.
 */
export const CHAT_PROPOSAL_STATUSES = [
	"pending",
	"agreed",
	"recorded",
	"failed",
	"declined",
] as const;
export type ChatProposalStatus = (typeof CHAT_PROPOSAL_STATUSES)[number];

/**
 * How the person agreed. `card`: they pressed Record it, the only way an agreement is made. `reply`:
 * a reply a chat bound to the proposal, which ISS-439's first build accepted (dev.195 to dev.197); no
 * path makes it now, and it stays readable so a proposal recorded that way says how it was.
 */
export const CHAT_AGREEMENT_VIAS = ["card", "reply"] as const;
export type ChatAgreementVia = (typeof CHAT_AGREEMENT_VIAS)[number];

/** What core holds: an Assistant tool call, or an Agent session's REST request. */
export const CHAT_PROPOSAL_FORMS = ["tool", "rest"] as const;
export type ChatProposalForm = (typeof CHAT_PROPOSAL_FORMS)[number];

export const CHAT_PROPOSAL_REFUSAL_CODES = [
	"CHAT_WRITE_AWAITS_AGREEMENT",
	"CHAT_PROPOSAL_UNKNOWN",
	"CHAT_PROPOSAL_SETTLED",
	"CHAT_PROPOSAL_NOT_YOURS",
	"CHAT_AGREEMENT_DOOR",
	"CHAT_AGREEMENT_SPENT",
	"CHAT_PROPOSAL_TOO_LARGE",
] as const;
export type ChatProposalRefusalCode =
	(typeof CHAT_PROPOSAL_REFUSAL_CODES)[number];

export const CHAT_PROPOSAL_REFUSAL_STATUSES = {
	CHAT_WRITE_AWAITS_AGREEMENT: 409,
	CHAT_PROPOSAL_UNKNOWN: 404,
	CHAT_PROPOSAL_SETTLED: 409,
	CHAT_PROPOSAL_NOT_YOURS: 403,
	CHAT_AGREEMENT_DOOR: 403,
	CHAT_AGREEMENT_SPENT: 403,
} as const satisfies RefusalStatuses<ChatProposalRefusalCode>;

/** The most a held REST body may carry: an attachment's own cap, with room for its envelope. */
export const CHAT_PROPOSAL_BODY_MAX_BYTES = 11 * 1024 * 1024;

/** What the card shows: what would be written, its lines, and the records it links to. */
export const chatProposalSummarySchema = z.strictObject({
	title: z.string(),
	lines: z.array(z.string()),
	relates: z.array(z.string()),
});
export type ChatProposalSummary = z.infer<typeof chatProposalSummarySchema>;

/** What was written once the person agreed: the record's key and where it is read. */
export const chatProposalRecordSchema = z.strictObject({
	ref: z.string().nullable(),
	href: z.string().nullable(),
});
export type ChatProposalRecord = z.infer<typeof chatProposalRecordSchema>;

export const chatProposalViewSchema = z.strictObject({
	id: z.uuid(),
	conversationId: z.uuid(),
	kind: z.enum(CHAT_PROPOSAL_KINDS),
	status: z.enum(CHAT_PROPOSAL_STATUSES),
	summary: chatProposalSummarySchema,
	proposedTo: z.strictObject({
		userId: z.uuid(),
		label: z.string().nullable(),
	}),
	/** The viewer is the person it waits on, and it still waits. */
	canDecide: z.boolean(),
	agreedVia: z.enum(CHAT_AGREEMENT_VIAS).nullable(),
	/** The person's own words, on a proposal a reply was bound to before agreement was the card alone. */
	agreedWords: z.string().nullable(),
	record: chatProposalRecordSchema.nullable(),
	/** Why the agreed write was refused, when it was. */
	failure: z.string().nullable(),
	createdAt: z.string(),
	decidedAt: z.string().nullable(),
});
export type ChatProposalView = z.infer<typeof chatProposalViewSchema>;

/**
 * Agreeing is the press itself: the person it waits on sends nothing more, from their own sign-in.
 * What they typed in the chat is never an agreement, so the request carries no words to bind.
 */
export const agreeChatProposalRequestSchema = z.strictObject({});
export type AgreeChatProposalRequest = z.infer<
	typeof agreeChatProposalRequestSchema
>;
export const AGREE_CHAT_PROPOSAL_SHAPE =
	"{} — the person it waits on agrees by pressing Record it, from their own sign-in; nothing else is sent, and a typed reply is never an agreement";
