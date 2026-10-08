// one declaration of the suggestion vocabulary (workflow suggestion-lifecycle rev 9, ISS-58):
// core's table CHECKs, REST, MCP and the web all import these values, the request schemas and the
// response shapes from here, so no surface can name a kind, status or code another does not know.

import { z } from "zod";
import { REASON_TEXT_MAX } from "./reason-text.js";
import {
	CONTRACT_WAIT_TARGET_REFUSAL_CODES,
	contractWaitTargetSchema,
} from "./contract-waits.js";
import {
	type FeedbackTriageEffect,
	feedbackDedupSchema,
	feedbackTriageSchema,
} from "./feedback.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import {
	REGISTRY_ISSUE_COMPLEXITIES,
	REGISTRY_ISSUE_PRIORITIES,
} from "./pipeline-registry.js";
import { ANSWER_VIEWS, pickFields } from "./projection.js";
import type { ProblemBody, RefusalStatuses } from "./refusal.js";
import {
	designChangePayloadSchema,
	WORKFLOW_STEP_ID,
} from "./workflow-health.js";

/** The six kinds rev 2 names, feedback_triage (workflow feedback-triage, ISS-59) and design_change (workflow step-health, REQ-17 BC-12); cluster, stale_requirement, conflict, verify and ask_reporter are deferred. */
export const SUGGESTION_KINDS = [
	"requirement_draft",
	"revision_diff",
	"readiness",
	"breakdown",
	"triage",
	"duplicate",
	"feedback_triage",
	"design_change",
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** proposed → accepted | rejected | stale | withdrawn (rev 3; only the producer withdraws). */
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
	"workflow",
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
const SUGGESTION_REFUSAL_CODES = [
	"SUGGESTION_PAYLOAD_INVALID",
	"SUGGESTION_TARGET_INVALID",
	"SUGGESTION_BASE_STALE",
	"SUGGESTION_DUPLICATE",
	"SUGGESTION_QUEUE_FULL",
	...PERMISSION_REFUSAL_CODES,
	"SUGGESTION_REJECT_REASON_REQUIRED",
	"SUGGESTION_DECIDED",
	"SUGGESTION_WITHDRAW_FORBIDDEN",
	"SUGGESTION_BLOCKER_UNKNOWN",
	"SUGGESTION_BLOCKER_TERMINAL",
	"SUGGESTION_BUILD_UNNAMED",
	"SUGGESTION_BUILD_UNPINNED",
	"SUGGESTION_BUILD_STEPS_UNBUILT",
	"SUGGESTION_REVISION_UNCHANGED",
	"SUGGESTION_BREAKDOWN_OPEN",
	"CLARIFICATION_ALREADY_OPEN",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	"SUGGESTION_DESIGN_UNKNOWN",
	"SUGGESTION_DESIGN_NOT_APPROVED",
	"SUGGESTION_JOURNEY_SUGGESTED",
	"SUGGESTION_REFUSED",
	...CONTRACT_WAIT_TARGET_REFUSAL_CODES,
] as const;
export type SuggestionRefusalCode = (typeof SUGGESTION_REFUSAL_CODES)[number];
export const SUGGESTION_REFUSAL_STATUSES = {
	SUGGESTION_BASE_STALE: 409,
} as const satisfies RefusalStatuses<SuggestionRefusalCode>;

export interface SuggestionRefusal {
	code: SuggestionRefusalCode;
	path: string;
	detail: string;
}

/** A requirement revision's spec, as ISS-57's revision write takes it. */
/**
 * A business question the revision leaves open: who answers it, and whether the agree waits for it
 * (REQUIREMENT_OPEN_QUESTIONS). Written without `questionId`, core asks it as a question on the
 * requirement and stores the id; a later revision carries the id to keep the same question.
 */
export const requirementOpenQuestionSchema = z.strictObject({
	question: z.string().trim().min(5).max(2_000),
	whoAnswers: z.string().trim().min(1).max(200),
	blocking: z.boolean(),
	questionId: z.uuid().optional(),
});

/** Something the revision takes as true without proof: whose it is, and how it will be confirmed. */
export const requirementAssumptionSchema = z.strictObject({
	text: z.string().trim().min(5).max(2_000),
	owner: z.string().trim().min(1).max(200),
	confirmBy: z.string().trim().min(3).max(1_000),
});

export const requirementSpecSchema = z.strictObject({
	goal: z.string().max(20_000).optional(),
	personas: z.array(z.string().max(500)).max(50).optional(),
	scopeIn: z.array(z.string().max(2_000)).max(100).optional(),
	scopeOut: z.array(z.string().max(2_000)).max(100).optional(),
	openQuestions: z.array(requirementOpenQuestionSchema).max(50).optional(),
	assumptions: z.array(requirementAssumptionSchema).max(50).optional(),
});

export const REQUIREMENT_SPEC_CLARITY_SHAPE =
	"spec.openQuestions?: [{ question, whoAnswers, blocking: boolean, questionId? }] — a blocking one open refuses the agree (REQUIREMENT_OPEN_QUESTIONS); spec.assumptions?: [{ text, owner, confirmBy }]";

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
	reason: z.string().trim().min(1).max(REASON_TEXT_MAX),
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

/** What a breakdown issue is filed with when its item leaves the field out (decision on design
 *  suggestion-lifecycle, ISS-117); complexity has no default, since an empty one picks the heaviest rung. */
export const BREAKDOWN_ISSUE_DEFAULTS = {
	priority: "medium",
	category: "feature",
} as const;

/** Each kind's payload and the targets it may name; a payload that does not parse is refused. */
export const SUGGESTION_PAYLOADS = {
	requirement_draft: {
		targets: ["issue", "workflow"],
		schema: z.strictObject({
			title: z.string().trim().min(1).max(500),
			...revisionWrite,
			/** On a workflow target (a first requirement, project-onboarding `requirements`): the
			 *  other approved designs it serves beside the journey it targets. */
			designs: z.array(z.uuid()).max(20).optional(),
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
									tracesTo: bcCode,
								}),
							)
							.min(1)
							.max(100),
						blockedBy: z.array(breakdownBlocker).max(50).optional(),
						complexity: z.enum(REGISTRY_ISSUE_COMPLEXITIES),
						priority: z.enum(REGISTRY_ISSUE_PRIORITIES).optional(),
						category: z.string().trim().min(1).max(100).optional(),
						builds: z.string().trim().min(1).max(200).nullable().optional(),
						/** The steps of the design it builds that the issue builds, named on its build link. */
						steps: z
							.array(z.string().regex(WORKFLOW_STEP_ID))
							.min(1)
							.max(40)
							.optional(),
						/** The provider versions the issue builds against that are not approved yet: each is written
						 *  as its wait (contract >= minVersion) in the accept's own transaction. */
						contractWaits: z
							.array(contractWaitTargetSchema)
							.min(1)
							.max(20)
							.optional(),
						/** The observed steps (nodes of the design's latest observation) the issue removes or rebuilds. */
						observedSteps: z
							.array(z.string().regex(WORKFLOW_STEP_ID))
							.min(1)
							.max(40)
							.optional(),
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
			note: z.string().trim().min(1).max(REASON_TEXT_MAX),
		}),
	},
	feedback_triage: {
		targets: ["feedback"],
		schema: feedbackTriageSchema.extend({
			dedup: feedbackDedupSchema.optional(),
		}),
	},
	design_change: {
		targets: ["workflow"],
		schema: designChangePayloadSchema,
	},
	duplicate: {
		targets: ["requirement", "issue"],
		schema: z.strictObject({
			duplicateOf: z.string().trim().min(1).max(200),
			similarity: z.number().min(0).max(1).optional(),
			note: z.string().max(REASON_TEXT_MAX).optional(),
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
	workflow: z.string().trim().min(1).max(200).optional(),
};

/** `POST /api/projects/:id/suggestions` — one of `requirement`, `issue`, `feedback` or `workflow`. */
export const createSuggestionRequestSchema = z.strictObject({
	kind: z.enum(SUGGESTION_KINDS),
	...targetFields,
	baseRevision: z.number().int().min(1).nullable(),
	payload: z.unknown(),
	model: z.string().max(200).nullable().optional(),
});
export const CREATE_SUGGESTION_SHAPE = `{ kind: ${SUGGESTION_KINDS.join(" | ")}, requirement | issue | feedback | workflow, baseRevision, payload, model? }`;

/** `POST /api/projects/:id/suggestions/:sid/accept` — the person's reason, kept on the row. */
export const acceptSuggestionRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
});
export const ACCEPT_SUGGESTION_SHAPE =
	"{ reason? } — why it is accepted, and on whose authority";

/** `POST /api/projects/:id/suggestions/:sid/revise` — a reviewer's edit: the original is rejected
 *  with `reason` and a new suggestion carrying `payload` is proposed by the reviewer (ISS-117). */
export const reviseSuggestionRequestSchema = z.strictObject({
	payload: z.unknown(),
	reason: z.string().max(REASON_TEXT_MAX),
});
export const REVISE_SUGGESTION_SHAPE =
	"{ payload, reason } — the whole payload as it should read, and why the original is changed";

/** `POST /api/projects/:id/suggestions/:sid/reject`. */
export const rejectSuggestionRequestSchema = z.strictObject({
	reason: z.string().max(REASON_TEXT_MAX),
});

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
	/** The suggestion this one revises: a reviewer's edit names the original it replaced. */
	revises: string | null;
	producerKind: SuggestionProducer;
	producerId: string | null;
	conversationMessageId: string | null;
	model: string | null;
	decidedBy: string | null;
	decidedAt: string | null;
	reason: string | null;
	createdAt: string;
	payloadPurgedAt: string | null;
	/** The list's reading of a proposed breakdown on a requirement (ISS-278); absent on every other
	 *  kind and status, and on a write's answer. */
	breakdown?: SuggestionBreakdownRead;
}

/** What one slice of a proposed breakdown waits on, as its accept would write the blocks edge: another
 *  slice of the same breakdown by index, an existing issue, or the refusal the accept would give. */
export type SuggestionBreakdownBlocker =
	| { slice: number; title: string }
	| { issue: string; title: string; status: string }
	| { ref: string; code: string; refusal: string };

/** One slice of a proposed breakdown, read from its stored payload at the requirement's head. */
export interface SuggestionBreakdownSlice {
	title: string;
	description: string | null;
	complexity: string;
	criteria: { code: string; body: string }[];
	/** The pinned design it builds and the revision the latest baseline pins it at; null when it
	 *  builds none, or where `buildsRefusal` says why the accept would refuse it. */
	builds: { flow: string; designRevision: number | null } | null;
	buildsRefusal: string | null;
	blockedBy: SuggestionBreakdownBlocker[];
}

/** A proposed breakdown as its accept would file it at the requirement's `revision`; a stored payload
 *  that no longer parses carries no slices and says why in `unreadable`. */
export interface SuggestionBreakdownRead {
	revision: number | null;
	slices: SuggestionBreakdownSlice[];
	uncovered: { code: string; reason: string }[];
	unreadable: string | null;
}

/** A revision_diff or requirement_draft accept: the revision it wrote, proposed for a revision_diff
 *  (the accept is its propose) and a draft for a first requirement. */
export interface SuggestionRevisionEffect {
	requirementId: string;
	requirement: string;
	revision: number;
	state: "draft" | "proposed";
	/** A first requirement's accept: the approved designs the new requirement was linked to. */
	designs?: string[];
}

/** One issue a breakdown accept filed: the fields written, the pinned design it builds, and which
 *  fields its item left out and took the default for. */
export interface SuggestionBreakdownIssue {
	issueId: string;
	key: string;
	priority: string;
	category: string;
	complexity: string;
	builds: string | null;
	defaulted: (keyof typeof BREAKDOWN_ISSUE_DEFAULTS)[];
	/** The waits its item named, as written: settled already where an approved version reaches it. */
	contractWaits: {
		waitId: string;
		contract: string;
		minVersion: string;
		dueAt: string | null;
		settledVersion: string | null;
	}[];
}

/** A breakdown accept: the draft issues it filed against the requirement at `revision`. */
export interface SuggestionBreakdownEffect {
	requirementId: string;
	requirement: string;
	revision: number;
	issues: SuggestionBreakdownIssue[];
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

/** A duplicate accept on a requirement: dropped as a duplicate of the requirement it repeats. */
export interface SuggestionRequirementDuplicateEffect {
	requirementId: string;
	requirement: string;
	duplicateOf: string;
	status: "dropped";
}

/** What an accept wrote, read back for the caller; never stored on the row. */
export type SuggestionEffect =
	| SuggestionRevisionEffect
	| SuggestionBreakdownEffect
	| SuggestionReadinessEffect
	| SuggestionIssueTriageEffect
	| SuggestionDuplicateEffect
	| SuggestionRequirementDuplicateEffect;

/** The answer to create, accept, reject, revise and withdraw. */
export interface SuggestionResponse {
	suggestion: SuggestionView;
	effect?: SuggestionEffect | FeedbackTriageEffect;
	/** A revise whose accept in the same act was refused: the revision stands at `proposed`, and
	 *  this names why it was not accepted, as a refusal's `error` reads. */
	acceptRefused?: ProblemBody["error"];
}

/** The answer to the list: the rows asked for, and how many are open on the target. */
export interface SuggestionListResponse {
	suggestions: SuggestionView[];
	open: number;
}

const SUGGESTION_SUMMARY_FIELDS = [
	"id",
	"kind",
	"status",
	"target",
	"baseRevision",
	"revises",
	"producerKind",
	"producerId",
	"model",
	"decidedBy",
	"decidedAt",
	"createdAt",
	"payloadPurgedAt",
] as const;

type SuggestionSummaryView = Pick<
	SuggestionView,
	(typeof SUGGESTION_SUMMARY_FIELDS)[number]
>;

export const suggestionSummaryOf = (
	view: SuggestionView,
): SuggestionSummaryView => pickFields(view, SUGGESTION_SUMMARY_FIELDS);
