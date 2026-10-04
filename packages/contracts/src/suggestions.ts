// cm:why one declaration of the suggestion vocabulary (workflow suggestion-lifecycle rev 2, ISS-58):
// core's table CHECKs, REST, MCP and the web all import these values, the request schemas and the
// response shapes from here, so no surface can name a kind, status or code another does not know.

import { z } from "zod";
import { type FeedbackTriageEffect, feedbackTriageSchema } from "./feedback.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { REGISTRY_ISSUE_COMPLEXITIES } from "./pipeline-registry.js";
import { ANSWER_VIEWS, pickFields } from "./projection.js";

/** The six kinds rev 2 names, and feedback_triage (workflow feedback-triage, ISS-59); cluster, stale_requirement, conflict, verify and ask_reporter are deferred. */
export const SUGGESTION_KINDS = [
	"requirement_draft",
	"revision_diff",
	"readiness",
	"breakdown",
	"triage",
	"duplicate",
	"feedback_triage",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** proposed → accepted | rejected | stale (rev 2), and withdrawn (the producer retracts; not yet drawn in rev 2). */
export const SUGGESTION_STATUSES = [
	"proposed",
	"accepted",
	"rejected",
	"stale",
	"withdrawn",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** How a person reads a suggestion's status: a proposal waits on a person; the rest are settled. */
export const SUGGESTION_STATUS_LABELS: Record<SuggestionStatus, string> = {
	proposed: "Awaiting a decision",
	accepted: "Accepted",
	rejected: "Rejected",
	stale: "Stale",
	withdrawn: "Withdrawn",
};

export const SUGGESTION_STATUS_TONES: Record<
	SuggestionStatus,
	IssueStatusTone
> = {
	proposed: "you",
	accepted: "ready",
	rejected: "done",
	stale: "done",
	withdrawn: "done",
};

export const SUGGESTION_STATUS_GLYPHS: Record<SuggestionStatus, string> = {
	proposed: "●",
	accepted: "✓",
	rejected: "×",
	stale: "↻",
	withdrawn: "–",
};

/** Who wrote it: the BA assistant door, an agent credential, or a person through REST. */
export const SUGGESTION_PRODUCERS = [
	"ba_assistant",
	"agent",
	"person",
] as const;
export type SuggestionProducer = (typeof SUGGESTION_PRODUCERS)[number];

/** What a suggestion is about: one arm of its exclusive arc. */
export const SUGGESTION_TARGET_TYPES = [
	"requirement",
	"issue",
	"feedback",
] as const;
export type SuggestionTargetType = (typeof SUGGESTION_TARGET_TYPES)[number];

/** An item embedding row's state: a write never skips in silence (Q7), a no_egress project's included (Q8). */
export const ITEM_EMBEDDING_STATUSES = [
	"embedded",
	"provider_not_configured",
	"failed",
	"withheld_by_policy",
] as const;
export type ItemEmbeddingStatus = (typeof ITEM_EMBEDDING_STATUSES)[number];

/** At most this many proposed suggestions wait on one target (SUGGESTION_QUEUE_FULL). */
export const SUGGESTION_MAX_OPEN_PER_TARGET = 5;
/** A suggestion nobody decided within this many days is marked stale by the retention sweep. */
export const SUGGESTION_STALE_AFTER_DAYS = 30;
/** A rejected, stale or withdrawn suggestion keeps its payload this many days after the decision. */
export const SUGGESTION_PURGE_PAYLOAD_AFTER_DAYS = 90;

/** Every refusal a suggestion write or the BA door answers with, by name. */
export const SUGGESTION_REFUSAL_CODES = [
	"SUGGESTION_PAYLOAD_INVALID",
	"SUGGESTION_TARGET_INVALID",
	"SUGGESTION_BASE_STALE",
	"SUGGESTION_DUPLICATE",
	"SUGGESTION_QUEUE_FULL",
	"SUGGESTION_ACCEPT_FORBIDDEN",
	"SUGGESTION_REJECT_REASON_REQUIRED",
	"SUGGESTION_DECIDED",
	"SUGGESTION_WITHDRAW_FORBIDDEN",
	"SUGGESTION_EFFECT_UNDECIDED",
	"SUGGESTION_BLOCKER_UNKNOWN",
	"SUGGESTION_BLOCKER_TERMINAL",
	"CLARIFICATION_ALREADY_OPEN",
] as const;
export type SuggestionRefusalCode = (typeof SUGGESTION_REFUSAL_CODES)[number];

export interface SuggestionRefusal {
	code: SuggestionRefusalCode;
	path: string;
	detail: string;
}

/** A requirement revision's spec, as ISS-57's revision write takes it. */
export const requirementSpecSchema = z.strictObject({
	goal: z.string().max(20_000).optional(),
	personas: z.array(z.string().max(500)).max(50).optional(),
	scopeIn: z.array(z.string().max(2_000)).max(100).optional(),
	scopeOut: z.array(z.string().max(2_000)).max(100).optional(),
});

export const REQUIREMENT_CRITERION_FORMS = ["statement", "scenario"] as const;

/** One criterion of a revision: a live BC code keeps it, no code takes the next one. */
export const requirementCriterionSchema = z.strictObject({
	code: z
		.string()
		.regex(/^BC-[1-9][0-9]*$/, "a criterion code reads BC-n")
		.optional(),
	body: z.string().trim().min(1).max(10_000),
	form: z.enum(REQUIREMENT_CRITERION_FORMS).optional(),
});

const revisionWrite = {
	reason: z.string().trim().min(1).max(4_000),
	spec: requirementSpecSchema.optional(),
	tldr: z.string().max(4_000).nullable().optional(),
	changeSummary: z.string().max(4_000).nullable().optional(),
	criteria: z.array(requirementCriterionSchema).max(200),
};

const bcCode = z.string().regex(/^BC-[1-9][0-9]*$/);

/** A breakdown issue's blocker: a number is the index of another issue in the same payload; a
 *  string names an existing live issue of the project by key (ISS-12) or uuid, so the order can
 *  run after another requirement's work (ISS-89). */
const breakdownBlocker = z.union([
	z.number().int().min(0),
	z.string().trim().min(1).max(200),
]);

/** Each kind's payload and the targets it may name; a payload that does not parse is refused. */
export const SUGGESTION_PAYLOADS = {
	requirement_draft: {
		targets: ["issue"],
		schema: z.strictObject({
			title: z.string().trim().min(1).max(500),
			...revisionWrite,
		}),
	},
	revision_diff: {
		targets: ["requirement"],
		schema: z.strictObject(revisionWrite),
	},
	readiness: {
		targets: ["requirement"],
		schema: z.strictObject({
			checks: z
				.array(
					z.strictObject({
						check: z.string().trim().min(1).max(200),
						passed: z.boolean(),
						detail: z.string().max(2_000).optional(),
					}),
				)
				.min(1)
				.max(20),
		}),
	},
	breakdown: {
		targets: ["requirement"],
		schema: z.strictObject({
			issues: z
				.array(
					z.strictObject({
						title: z.string().trim().min(1).max(500),
						description: z.string().max(20_000).optional(),
						criteria: z
							.array(
								z.strictObject({
									body: z.string().trim().min(1).max(4_000),
									tracesTo: bcCode.optional(),
								}),
							)
							.max(100)
							.optional(),
						blockedBy: z.array(breakdownBlocker).max(50).optional(),
					}),
				)
				.min(1)
				.max(30),
			uncovered: z
				.array(z.strictObject({ code: bcCode, reason: z.string() }))
				.max(100)
				.optional(),
		}),
	},
	triage: {
		targets: ["issue"],
		schema: z.strictObject({
			priority: z.enum(["low", "medium", "high", "critical"]).optional(),
			category: z.string().max(100).optional(),
			complexity: z.enum(REGISTRY_ISSUE_COMPLEXITIES).optional(),
			route: z.string().max(200).optional(),
			note: z.string().trim().min(1).max(4_000),
		}),
	},
	feedback_triage: {
		targets: ["feedback"],
		schema: feedbackTriageSchema,
	},
	duplicate: {
		targets: ["requirement", "issue"],
		schema: z.strictObject({
			duplicateOf: z.string().trim().min(1).max(200),
			similarity: z.number().min(0).max(1).optional(),
			note: z.string().max(4_000).optional(),
		}),
	},
} as const satisfies Record<
	SuggestionKind,
	{ targets: readonly SuggestionTargetType[]; schema: z.ZodType }
>;

const targetFields = {
	requirement: z.string().trim().min(1).max(64).optional(),
	issue: z.string().trim().min(1).max(200).optional(),
	feedback: z.string().trim().min(1).max(64).optional(),
};

/** `POST /api/projects/:id/suggestions` — one of `requirement`, `issue` or `feedback`. */
export const createSuggestionRequestSchema = z.strictObject({
	kind: z.enum(SUGGESTION_KINDS),
	...targetFields,
	baseRevision: z.number().int().min(1).nullable(),
	payload: z.unknown(),
	model: z.string().max(200).nullable().optional(),
});
export type CreateSuggestionRequest = z.infer<
	typeof createSuggestionRequestSchema
>;
export const CREATE_SUGGESTION_SHAPE = `{ kind: ${SUGGESTION_KINDS.join(" | ")}, requirement | issue | feedback, baseRevision, payload, model? }`;

/** `POST /api/projects/:id/suggestions/:sid/accept` — the person's reason, kept on the row. */
export const acceptSuggestionRequestSchema = z.strictObject({
	reason: z.string().max(4_000).nullable().optional(),
});
export type AcceptSuggestionRequest = z.infer<
	typeof acceptSuggestionRequestSchema
>;
export const ACCEPT_SUGGESTION_SHAPE =
	"{ reason? } — why it is accepted, and on whose authority";

/** `POST /api/projects/:id/suggestions/:sid/reject`. */
export const rejectSuggestionRequestSchema = z.strictObject({
	reason: z.string().max(4_000),
});
export type RejectSuggestionRequest = z.infer<
	typeof rejectSuggestionRequestSchema
>;

/** `GET /api/projects/:id/suggestions` — `status` is comma-separated. */
export const listSuggestionsQuerySchema = z.strictObject({
	...targetFields,
	status: z
		.string()
		.optional()
		.transform((s) => (s ? s.split(",") : undefined))
		.pipe(z.array(z.enum(SUGGESTION_STATUSES)).optional()),
	view: z.enum(ANSWER_VIEWS).optional(),
});

/** One suggestion as every reader sees it. */
export interface SuggestionView {
	id: string;
	kind: SuggestionKind;
	status: SuggestionStatus;
	target: { type: SuggestionTargetType; id: string };
	baseRevision: number | null;
	/** null once purged, 90 days after a rejection, stale mark or withdrawal. */
	payload: unknown;
	payloadVersion: number;
	fingerprint: string;
	producerKind: SuggestionProducer;
	producerId: string | null;
	conversationMessageId: string | null;
	model: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	reason: string | null;
	createdAt: string;
	payloadPurgedAt: string | null;
}

/** A revision_diff or requirement_draft accept: the draft revision it wrote. */
export interface SuggestionRevisionEffect {
	requirementId: string;
	requirement: string;
	revision: number;
}

/** A breakdown accept: the draft issues it filed against the requirement at `revision`. */
export interface SuggestionBreakdownEffect {
	requirementId: string;
	requirement: string;
	revision: number;
	issues: { issueId: string; key: string }[];
}

/** A readiness accept: the accepted row is the readiness result at `revision` (no readiness table). */
export interface SuggestionReadinessEffect {
	requirementId: string;
	requirement: string;
	revision: number | null;
	ready: boolean;
	failed: string[];
}

export interface SuggestionIssueTriageEffect {
	issueId: string;
	issue: string;
	priority: string | null;
	category: string | null;
	complexity: string | null;
	routeCommentId: string | null;
}

/** A duplicate accept on an issue: dropped as a duplicate of its root, with a relates edge to it. */
export interface SuggestionDuplicateEffect {
	issueId: string;
	issue: string;
	duplicateOf: string;
	status: "dropped";
}

/** What an accept wrote, read back for the caller; never stored on the row. */
export type SuggestionEffect =
	| SuggestionRevisionEffect
	| SuggestionBreakdownEffect
	| SuggestionReadinessEffect
	| SuggestionIssueTriageEffect
	| SuggestionDuplicateEffect;

/** The answer to create, accept, reject and withdraw. */
export interface SuggestionResponse {
	suggestion: SuggestionView;
	effect?: SuggestionEffect | FeedbackTriageEffect;
}

/** The answer to the list: the rows asked for, and how many are open on the target. */
export interface SuggestionListResponse {
	suggestions: SuggestionView[];
	open: number;
}

export const SUGGESTION_SUMMARY_FIELDS = [
	"id",
	"kind",
	"status",
	"target",
	"baseRevision",
	"producerKind",
	"producerId",
	"model",
	"decidedBy",
	"decidedAt",
	"createdAt",
	"payloadPurgedAt",
] as const;

export type SuggestionSummaryView = Pick<
	SuggestionView,
	(typeof SUGGESTION_SUMMARY_FIELDS)[number]
>;

export const suggestionSummaryOf = (view: SuggestionView): SuggestionSummaryView =>
	pickFields(view, SUGGESTION_SUMMARY_FIELDS);
