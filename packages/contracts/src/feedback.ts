// one declaration of the product feedback vocabulary (workflows feedback-lifecycle rev 2 and
// feedback-triage rev 2, ISS-59): core's table CHECKs, REST, MCP and the web import the values, the
// request schemas and the response shapes from here.

import { z } from "zod";
import type {
	AgentReportKind,
	AgentReportSeverity,
	AgentReportTarget,
} from "./agent-reports.js";
import { type Said, saidSchema } from "./said.js";
import { REASON_LINE_MAX } from "./reason-text.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import {
	REGISTRY_ISSUE_COMPLEXITIES,
	REGISTRY_ISSUE_PRIORITIES,
} from "./pipeline-registry.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabels,
	WaitingKind,
} from "./standing.js";
import { type NodeRef, nodeRefSchema } from "./workflow-health.js";

/** What the reporter says it is; `contract_change` is filed by core for a breaking version (E3). */
export const FEEDBACK_KINDS = [
	"bug",
	"change_request",
	"question",
	"idea",
	"contract_change",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_SEVERITIES = [
	"low",
	"medium",
	"high",
	"critical",
] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

/** The stored statuses: each is a person's decision. `planned` and `resolved` are read, never stored (Q1). */
export const FEEDBACK_STATUSES = [
	"new",
	"triaged",
	"reopened",
	"verified",
	"declined",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** What a reader sees: the stored status, with `triaged` read as planned or resolved from the linked work. */
export const FEEDBACK_PHASES = [
	"new",
	"triaged",
	"planned",
	"resolved",
	"reopened",
	"verified",
	"declined",
] as const;
export type FeedbackPhase = (typeof FEEDBACK_PHASES)[number];

/** The phases a person still has to triage: never routed, or sent back by the reporter. */
export const FEEDBACK_UNTRIAGED_PHASES = [
	"new",
	"reopened",
] as const satisfies readonly FeedbackPhase[];

/**
 * What one item is about: an exclusive arc of six foreign keys, or a screen named in words; core
 * alone files against a contract version (E3). An `endpoint` is a route or tool the project serves:
 * an element of the current version of an openapi or mcp-tools contract it provides (ISS-279).
 */
export const FEEDBACK_TARGET_TYPES = [
	"requirement",
	"issue",
	"release",
	"workflow",
	"contract",
	"endpoint",
	"screen",
] as const;
export type FeedbackTargetType = (typeof FEEDBACK_TARGET_TYPES)[number];

/** Where triage sends an item; each names the one `routed_*` column (or `answer`, `duplicate_of`) it sets. */
export const FEEDBACK_ROUTES = [
	"issue",
	"revision",
	"new_requirement",
	"answer",
	"duplicate",
] as const;
export type FeedbackRoute = (typeof FEEDBACK_ROUTES)[number];

/** What triage may decide (requirement-to-delivery step `triage`): a stored route, or decline, which
 *  is its own act and status and never a route column value. */
export const FEEDBACK_TRIAGE_ROUTES = [...FEEDBACK_ROUTES, "decline"] as const;
export type FeedbackTriageRoute = (typeof FEEDBACK_TRIAGE_ROUTES)[number];

/** One row per decision on an item, insert-only, so a re-triage keeps the history (domain-entities.md "Records and audit"). */
export const FEEDBACK_DECISIONS = [
	"triaged",
	"declined",
	"verified",
	"reopened",
	"redacted",
	"promoted",
	"routed",
	"retargeted",
	"accepted",
	"snoozed",
] as const;
export type FeedbackDecision = (typeof FEEDBACK_DECISIONS)[number];

/** Who a row waits on, as the list groups it for the viewer. */
export const FEEDBACK_ATTENTION_GROUPS = [
	"needs_you",
	"moving",
	"waiting",
	"done",
] as const satisfies readonly StandingGroup[];
export type FeedbackAttentionGroup = (typeof FEEDBACK_ATTENTION_GROUPS)[number];

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
	bug: "Bug",
	change_request: "Change request",
	question: "Question",
	idea: "Idea",
	contract_change: "Contract change",
};

export const FEEDBACK_PHASE_LABELS: Record<FeedbackPhase, string> = {
	new: "New",
	triaged: "Triaged",
	planned: "Planned",
	resolved: "Resolved",
	reopened: "Reopened",
	verified: "Verified",
	declined: "Declined",
};

export const FEEDBACK_SEVERITY_LABELS: Record<FeedbackSeverity, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	critical: "Critical",
};

export const FEEDBACK_ROUTE_LABELS: Record<FeedbackRoute, string> = {
	issue: "Issue",
	revision: "Revision",
	new_requirement: "New requirement",
	answer: "Answer",
	duplicate: "Duplicate",
};

export const FEEDBACK_DECISION_LABELS: Record<FeedbackDecision, string> = {
	triaged: "Triaged",
	declined: "Declined",
	verified: "Verified",
	reopened: "Reopened",
	redacted: "Reporter data deleted",
	routed: "Route written",
	promoted: "Promoted from an agent report",
	retargeted: "Target changed",
	accepted: "Accepted",
	snoozed: "Snoozed",
};

export const FEEDBACK_TARGET_LABELS: Record<FeedbackTargetType, string> = {
	requirement: "Requirement",
	issue: "Issue",
	release: "Release",
	workflow: "Workflow",
	contract: "Contract version",
	endpoint: "API route or tool",
	screen: "Screen",
};

export const FEEDBACK_ATTENTION_LABELS: StandingGroupLabels<FeedbackAttentionGroup> =
	{
		needs_you: {
			label: "Needs you",
			hint: "Triage it, or confirm the fix you reported",
			tone: "you",
			collapsed: false,
		},
		moving: {
			label: "Moving",
			hint: "An issue, revision or requirement carries it",
			tone: "run",
			collapsed: false,
		},
		waiting: {
			label: "Someone else’s turn",
			hint: "The reporter confirms the fix",
			tone: "neutral",
			collapsed: false,
		},
		done: {
			label: "Done",
			hint: "Verified or declined",
			tone: "done",
			collapsed: true,
		},
	};

export const FEEDBACK_PHASE_TONES: Record<FeedbackPhase, IssueStatusTone> = {
	new: "you",
	triaged: "you",
	planned: "run",
	resolved: "neutral",
	reopened: "err",
	verified: "done",
	declined: "done",
};

/** The mark each phase badge draws in its dot's place, so a phase is not told by colour alone. */
export const FEEDBACK_PHASE_GLYPHS: Record<FeedbackPhase, string> = {
	new: "●",
	triaged: "◐",
	planned: "→",
	resolved: "✓",
	reopened: "↺",
	verified: "✓",
	declined: "×",
};

export const FEEDBACK_PHASE_HINTS: Record<FeedbackPhase, string> = {
	new: "new: not triaged; a person picks a route",
	triaged: "triaged: the route's carrier died, and a person routes it again",
	planned: "planned: an issue, revision or requirement carries it",
	resolved:
		"resolved: the linked work shipped; waiting on the reporter to verify",
	reopened: "reopened: the reporter says it is not fixed; back to triage",
	verified: "verified: a person confirmed the fix; never automatic",
	declined: "declined: not doing it, with a reason the reporter sees",
};

export const FEEDBACK_SEVERITY_TONES: Record<
	FeedbackSeverity,
	IssueStatusTone
> = {
	low: "neutral",
	medium: "neutral",
	high: "you",
	critical: "err",
};

/**
 * How long a resolved item waits for someone to confirm the fix before Forge verifies it itself
 * (owner, 2026-10-07): the project's `feedback.verifyWindowDays`, whole days inside these bounds.
 */
export const FEEDBACK_VERIFY_WINDOW = {
	defaultDays: 7,
	minDays: 1,
	maxDays: 90,
} as const;

/** Field limits a feedback write is held to. */
export const FEEDBACK_LIMITS = {
	title: 300,
	body: 20_000,
	whereSeen: 500,
	reason: 4_000,
	answer: 10_000,
	/** The issues one issue route names at most. */
	carriers: 50,
	attachmentBytes: 5 * 1024 * 1024,
	attachmentsPerItem: 10,
	/** The longest a snooze may run: past it the item is not parked, it is forgotten. */
	snoozeDays: 365,
	message: 4_000,
} as const;

/** Every refusal a feedback write answers with, by name. Who-may-act codes end `_FORBIDDEN`. */
export const FEEDBACK_REFUSAL_CODES = [
	"FEEDBACK_REFUSED",
	"FEEDBACK_TARGET_UNKNOWN",
	"FEEDBACK_TARGET_NOT_IN_PROJECT",
	"FEEDBACK_TARGET_NOT_ONE",
	"FEEDBACK_SCREEN_TWICE",
	"FEEDBACK_TARGET_UNCHANGED",
	"FEEDBACK_TARGET_CORE_FILED",
	"FEEDBACK_ROUTE_TARGET_MISMATCH",
	"FEEDBACK_ROUTE_INCOMPLETE",
	"FEEDBACK_CARRIER_REPEATED",
	"FEEDBACK_ANSWER_MISSING",
	"FEEDBACK_DECLINE_REASON_REQUIRED",
	"FEEDBACK_REOPEN_REASON_REQUIRED",
	"FEEDBACK_DUPLICATE_CHAIN",
	"FEEDBACK_DUPLICATE_SELF",
	"FEEDBACK_DUPLICATE_OF_DECLINED",
	"FEEDBACK_SNOOZE_PAST",
	"FEEDBACK_SNOOZE_TOO_FAR",
	"FEEDBACK_SNOOZE_REASON_REQUIRED",
	"FEEDBACK_MESSAGE_EMPTY",
	"FEEDBACK_MESSAGE_NO_RECIPIENT",
	"FEEDBACK_RELAY_NOT_TO_REPORTERS",
	"FEEDBACK_ALREADY_TOLD",
	"FEEDBACK_STATUS_INVALID",
	"FEEDBACK_NOT_RESOLVED",
	"FEEDBACK_VERIFY_ASK_SELF",
	"FEEDBACK_ALREADY_REDACTED",
	"FEEDBACK_CLARIFICATION_ALREADY_OPEN",
	"FEEDBACK_CLARIFICATION_CLOSED",
	"FEEDBACK_ATTACHMENT_INVALID",
	...PERMISSION_REFUSAL_CODES,
	"FEEDBACK_SEARCH_WITHHELD",
	"FEEDBACK_SOURCE_ALREADY_PROMOTED",
	"FEEDBACK_SOURCE_NOT_IN_PROJECT",
	"FEEDBACK_SOURCE_ROUTED_ELSEWHERE",
	"FEEDBACK_NODE_NEEDS_WORKFLOW",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
	// a contract change routed to an issue writes its contract wait there (requirement-to-delivery triage)
	"CONTRACT_WAIT_DUPLICATE",
	"CONTRACT_WAIT_ISSUE_FINISHED",
] as const;
export type FeedbackRefusalCode = (typeof FEEDBACK_REFUSAL_CODES)[number];

export interface FeedbackRefusal {
	code: FeedbackRefusalCode;
	path: string;
	detail: string;
}

const ref = z.string().trim().min(1).max(200);
const reason = z.string().max(FEEDBACK_LIMITS.reason);

/** The contract types whose elements are routes or tools a project serves, and so an `endpoint` target. */
export const FEEDBACK_ENDPOINT_CONTRACT_TYPES = ["openapi", "mcp-tools"] as const;
export type FeedbackEndpointContractType =
	(typeof FEEDBACK_ENDPOINT_CONTRACT_TYPES)[number];

/** The target fields a create names exactly one of (FEEDBACK_TARGET_NOT_ONE otherwise). */
const feedbackTargetFields = {
	requirement: ref.optional(),
	issue: ref.optional(),
	release: ref.optional(),
	workflow: ref.optional(),
	/** A route (`METHOD /path`) or tool the project serves, bare or as `<contract>:<element>`. */
	endpoint: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen).optional(),
	screen: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen).optional(),
	/** With a workflow target, the one step or edge of it the item is about (REQ-17 BC-11). */
	node: nodeRefSchema.optional(),
};

/** `POST /api/projects/:id/feedback`. */
export const createFeedbackRequestSchema = z.strictObject({
	kind: z.enum(FEEDBACK_KINDS),
	severity: z.enum(FEEDBACK_SEVERITIES).optional(),
	title: z.string().trim().min(1).max(FEEDBACK_LIMITS.title),
	body: z.string().max(FEEDBACK_LIMITS.body).optional(),
	whereSeen: z.string().trim().max(FEEDBACK_LIMITS.whereSeen).optional(),
	...feedbackTargetFields,
});
export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>;
export const CREATE_FEEDBACK_SHAPE = `{ kind: ${FEEDBACK_KINDS.join(" | ")}, title, body?, severity?: ${FEEDBACK_SEVERITIES.join(" | ")}, whereSeen?, exactly one of requirement | issue | release | workflow | endpoint | screen, node?: { step } | { edge: { from, to, label? } } (with workflow only) }`;

const carrierFields = {
	/** One issue that carries the route, or every one of them as a list (ISS-265). */
	issue: z.union([ref, z.array(ref).min(1).max(FEEDBACK_LIMITS.carriers)]).optional(),
	createIssue: z
		.strictObject({
			title: z.string().trim().min(1).max(FEEDBACK_LIMITS.title).optional(),
			description: z.string().max(FEEDBACK_LIMITS.body).optional(),
			/** The filed issue's bands; absent, priority follows the severity and category the kind. */
			complexity: z.enum(REGISTRY_ISSUE_COMPLEXITIES).optional(),
			category: z.string().trim().min(1).max(100).optional(),
			priority: z.enum(REGISTRY_ISSUE_PRIORITIES).optional(),
		})
		.optional(),
	suggestion: z.uuid().optional(),
	requirement: ref.optional(),
	title: z.string().trim().min(1).max(FEEDBACK_LIMITS.title).optional(),
	answer: z.string().max(FEEDBACK_LIMITS.answer).optional(),
	duplicateOf: ref.optional(),
	note: z.string().max(FEEDBACK_LIMITS.reason).optional(),
};

/**
 * A route as a person picks it, or as a `feedback_triage` suggestion carries it, written in the
 * triage act with what carries it: issue: `issue` links one existing issue or a list of them,
 * `createIssue` (or neither) files a draft; revision: `suggestion` names a revision_diff
 * suggestion; new_requirement: `requirement` names a draft, `title` starts one; answer: `answer`.
 * duplicate names its root (`duplicateOf`), and decline its reason (`note`).
 */
export const feedbackTriageSchema = z.strictObject({
	route: z.enum(FEEDBACK_TRIAGE_ROUTES),
	...carrierFields,
	kind: z.enum(FEEDBACK_KINDS).optional(),
	severity: z.enum(FEEDBACK_SEVERITIES).optional(),
});
export type FeedbackTriage = z.infer<typeof feedbackTriageSchema>;
export const FEEDBACK_TRIAGE_SHAPE = `{ route: ${FEEDBACK_TRIAGE_ROUTES.join(" | ")}, issue?: ISS-n | [ISS-n, …] | createIssue?: { title?, description?, complexity?, category?, priority? } | suggestion? | requirement? | title? | answer? | duplicateOf?, kind?, severity?, note? (decline: the reason) }`;

/** Stamped by core on a `feedback_triage` suggestion: the nearest item, or why dedup did not run. */
export const feedbackDedupSchema = z.strictObject({
	ran: z.boolean(),
	nearest: z.string().nullable(),
	similarity: z.number().min(-1).max(1).optional(),
	why: z.string().max(REASON_LINE_MAX).optional(),
	/** `why` as said (`said.ts`); absent on a payload stamped before core said it. */
	says: z.strictObject({ why: saidSchema }).optional(),
});
export type FeedbackDedup = z.infer<typeof feedbackDedupSchema>;

export const promoteAgentReportRequestSchema = z.strictObject({
	agentReport: z.uuid(),
	kind: z.enum(FEEDBACK_KINDS),
	severity: z.enum(FEEDBACK_SEVERITIES).optional(),
	title: z.string().trim().min(1).max(FEEDBACK_LIMITS.title).optional(),
	body: z.string().max(FEEDBACK_LIMITS.body).optional(),
	whereSeen: z.string().trim().max(FEEDBACK_LIMITS.whereSeen).optional(),
	...feedbackTargetFields,
});
export type PromoteAgentReportRequest = z.infer<
	typeof promoteAgentReportRequestSchema
>;
export const PROMOTE_AGENT_REPORT_SHAPE = `{ agentReport: uuid, kind: ${FEEDBACK_KINDS.join(" | ")}, title?, body?, severity?, whereSeen?, exactly one of requirement | issue | release | workflow | endpoint | screen, node?: { step } | { edge: { from, to, label? } } (with workflow only) }`;

/**
 * `POST …/feedback/:fb/retarget`: what the item is about, corrected by a holder of feedback.approve.
 * Exactly one target, resolved and refused as at create; `reason` is the approver's note.
 */
export const feedbackRetargetRequestSchema = z.strictObject({
	...feedbackTargetFields,
	reason: reason.optional(),
});
export type FeedbackRetargetRequest = z.infer<
	typeof feedbackRetargetRequestSchema
>;
export const FEEDBACK_RETARGET_SHAPE =
	"{ exactly one of requirement | issue | release | workflow | endpoint | screen, node?: { step } | { edge: { from, to, label? } } (with workflow only), reason? }";

/** `POST …/feedback/:fb/reopen`: the reason the reporter gives. */
export const feedbackReasonRequestSchema = z.strictObject({ reason });
export const FEEDBACK_REASON_SHAPE = "{ reason } says why";

/** `POST …/feedback/:fb/verify`. */
export const feedbackVerifyRequestSchema = z.strictObject({
	note: z.string().max(FEEDBACK_LIMITS.reason).optional(),
});
export const FEEDBACK_VERIFY_SHAPE = "{ note? }";

/** `POST …/feedback/:fb/accept`: new or reopened to triaged without a route, optionally about a requirement. */
export const feedbackAcceptRequestSchema = z.strictObject({
	requirement: ref.optional(),
});
export const FEEDBACK_ACCEPT_SHAPE = "{ requirement?: REQ-n }";

/** `POST …/feedback/:fb/snooze`: parked out of New until `until`, with the reason a triager reads on return. */
export const feedbackSnoozeRequestSchema = z.strictObject({
	until: z.iso.datetime({ offset: true }),
	reason,
});
export const FEEDBACK_SNOOZE_SHAPE = "{ until: ISO 8601 date-time, reason }";

/** Who a message reaches: the item's own reporter, every reporter merged into it, or nobody (a note for members). */
export const FEEDBACK_MESSAGE_AUDIENCES = [
	"reporter",
	"all_reporters",
	"internal",
] as const;
export type FeedbackMessageAudience =
	(typeof FEEDBACK_MESSAGE_AUDIENCES)[number];

/**
 * `POST …/feedback/:fb/messages` sends; `…/messages/preview` answers what it would send, writing nothing.
 * `relayed` records what a person told reporters outside Forge (one no bell reaches, an agent, or a
 * person who turned the notice off): it is kept on the thread and sends no notice.
 */
export const feedbackMessageRequestSchema = z.strictObject({
	audience: z.enum(FEEDBACK_MESSAGE_AUDIENCES),
	text: z.string().max(FEEDBACK_LIMITS.message),
	relayed: z.boolean().optional(),
});
export const FEEDBACK_MESSAGE_SHAPE = `{ audience: ${FEEDBACK_MESSAGE_AUDIENCES.join(" | ")}, text, relayed?: boolean }`;

export const feedbackEmptyRequestSchema = z.strictObject({});
export const FEEDBACK_EMPTY_SHAPE = "{}";

/** `POST …/feedback/:fb/clarification`: one open question to the reporter (Q5). */
export const feedbackClarificationRequestSchema = z.strictObject({
	prompt: z.string().trim().min(5).max(2_000),
	needed: z.string().trim().min(3).max(1_000),
});
export const FEEDBACK_CLARIFICATION_SHAPE = "{ prompt, needed }";

/** `POST …/feedback/:fb/attachments`: bytes as base64, flagged on a sensitive project. */
export const feedbackAttachmentRequestSchema = z.strictObject({
	name: z.string().trim().min(1).max(200),
	mime: z.string().trim().min(3).max(200),
	contentBase64: z.string().min(4),
});
export const FEEDBACK_ATTACHMENT_SHAPE = "{ name, mime, contentBase64 }";

/** `GET /api/projects/:id/feedback` — `phase` is comma-separated. */
export const listFeedbackQuerySchema = z.strictObject({
	phase: z
		.string()
		.optional()
		.transform((s) => (s ? s.split(",") : undefined))
		.pipe(z.array(z.enum(FEEDBACK_PHASES)).optional()),
	q: z.string().max(200).optional(),
	requirement: z.string().trim().min(1).max(64).optional(),
});

export interface FeedbackTargetView {
	type: FeedbackTargetType;
	/** REQ-n, ISS-n, a release version, a workflow flow, `<provider>/<contract>@<version>`, a served
	 *  route or tool as `<contract>:<element>`, or the screen as written. */
	key: string;
	title: string | null;
	/** On a workflow target, the step or edge the item names; absent, it is about the whole workflow. */
	node?: NodeRef;
}

/** One route or tool a project serves, as `GET …/feedback/endpoints` lists it for the About picker. */
export interface FeedbackEndpointView {
	/** `<contract>:<element>`, the name a create or retarget may send as `endpoint`. */
	key: string;
	contract: string;
	version: string;
	type: FeedbackEndpointContractType;
	element: string;
}

export interface FeedbackEndpointsResponse {
	endpoints: FeedbackEndpointView[];
}

/** One thing carrying a route: ISS-n, REQ-n, a suggestion id or FB-n, with its own status in its own vocabulary. */
export interface FeedbackCarrierView {
	key: string | null;
	status: string | null;
	/** The version of the release an issue carrier is cut into; absent on any other carrier and until cut. */
	release?: string | null;
}

export interface FeedbackRouteView {
	route: FeedbackRoute;
	/** What carries it: every issue of an issue route, the one carrier of another, none for an answer. */
	carriers: FeedbackCarrierView[];
	answer: string | null;
}

export interface FeedbackDecisionView {
	decision: FeedbackDecision;
	route: FeedbackRoute | null;
	carrier: string | null;
	reason: string | null;
	/** Null on a decision Forge took itself, which has no person. */
	decidedBy: string | null;
	decidedByName: string | null;
	decidedAgency: "human" | "agent" | "system";
	decidedAt: string;
	fromSuggestionId: string | null;
	/** The person's reason on the accept of the suggestion that wrote this decision (ISS-281); null
	 *  when it came from no suggestion, the accept gave none, or the item's text is withheld. */
	acceptReason: string | null;
	/** `reason` as said: a person's words carried as written, Forge's own by its key. */
	says: { reason: Said | null };
}

/** One person who reported the item, itself or by a duplicate merged into it (`from` names that duplicate). */
export interface FeedbackReporterView {
	id: string;
	name: string | null;
	agency: "human" | "agent";
	/** The duplicate this reporter filed, when they reported it by one; null for the item's own reporter. */
	from: string | null;
}

/** What a reader sees of one message: a notice a reporter received, or an internal note members keep. */
export interface FeedbackMessageView {
	id: string;
	audience: FeedbackMessageAudience;
	text: string;
	sentBy: string;
	sentByName: string | null;
	sentAgency: "human" | "agent";
	sentAt: string;
	/** The reporters it was addressed to; empty for an internal note, which reaches no one, and for a relay. */
	recipients: { id: string; name: string | null }[];
	/** A person told the reporters outside Forge and recorded what they said; no bell carried it. */
	relayed: boolean;
}

/** The exact notice a send would deliver, as its reporters will read it, and who gets it. */
export interface FeedbackMessagePreview {
	audience: Exclude<FeedbackMessageAudience, "internal">;
	title: string;
	body: string;
	recipients: { id: string; name: string | null }[];
	/** Reporters who have no bell and so are not told by it: named, never skipped. */
	notReached: { id: string; name: string | null; why: string }[];
}

export interface FeedbackMessagePreviewResponse {
	preview: FeedbackMessagePreview;
}

export interface FeedbackSourceView {
	agentReport: {
		id: string;
		kind: AgentReportKind;
		severity: AgentReportSeverity;
		target: AgentReportTarget;
		targetRef: string | null;
		createdAt: string;
	};
}

export interface FeedbackAttachmentView {
	id: string;
	/** The duplicate this evidence was filed on, when it moved here with it; null on the item's own. */
	from: string | null;
	name: string;
	mime: string;
	size: number;
	/** On a sensitive project: may hold personal data, so it is never sent to a provider. */
	flagged: boolean;
	createdAt: string;
	/** Where its bytes are read: the item's own attachment route, under the item's key. */
	url: string;
}

/** Whose turn a row is: `you` is the viewer, `issue` a carrier (an issue, a requirement, a root
 *  item), `none` nothing is owed. */
export const FEEDBACK_WAITING_KINDS = [
	"you",
	"person",
	"agent",
	"issue",
	"none",
] as const satisfies readonly WaitingKind[];
export type FeedbackWaitingKind = (typeof FEEDBACK_WAITING_KINDS)[number];

/** One item as a list row reads it; the derived facts are the server's, never the client's. */
export interface FeedbackSummary
	extends Standing<FeedbackAttentionGroup, FeedbackWaitingKind> {
	/** Set on a shipped issue-routed item nothing told its reporter, by which of the two it is. */
	reporterNotTold: FeedbackNotTold | null;
	id: string;
	key: string;
	title: string;
	kind: FeedbackKind;
	severity: FeedbackSeverity;
	status: FeedbackStatus;
	phase: FeedbackPhase;
	target: FeedbackTargetView;
	route: FeedbackRouteView | null;
	reporter: { id: string; name: string | null; agency: "human" | "agent" };
	dueAt: string | null;
	/** Parked out of New until then, with the reason; null when not snoozed or the snooze ran out. */
	snoozed: { until: string; reason: string | null } | null;
	redacted: boolean;
	redactedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** How the reporter heard the work shipped: the release's own notice, a message to reporters, or a relay a person recorded. */
export const FEEDBACK_TOLD_HOWS = ["notice", "message", "relayed"] as const;
export type FeedbackToldHow = (typeof FEEDBACK_TOLD_HOWS)[number];

/**
 * Whether the reporter was told the work shipped: how, when and for which release; or why nobody was
 * told, so a reporter Forge cannot reach is named, never skipped.
 */
export type FeedbackShipNotice =
	| {
			state: "told";
			how: FeedbackToldHow;
			at: string;
			release: string | null;
			/** Who sent the message or recorded the relay; null for the release's own notice. */
			by: string | null;
			/** When and in which release the work shipped, as the not-told reading names it. */
			shipped: { at: string | null; release: string | null };
			/** How a person told them, in English (`a message from Dana`); null for the release's own notice. */
			told: string | null;
			says: { told: Said | null };
	  }
	| {
			state: "not_told";
			reason: string;
			says: { reason: Said };
			/** What the record says about the ship itself: when, and in which release (null when no release carries it). */
			shipped: { at: string | null; release: string | null };
			/** The work shipped before this project's first release notice, so no release owed this reporter one; nobody owes a relay. */
			beforeNotices: boolean;
			/** This project's first release notice, the cutoff `beforeNotices` is read against; null while none was sent. */
			noticesBegan: string | null;
	  };

/** Why a shipped item's reporter was not told: a relay is owed, or it shipped before release notices existed. */
export type FeedbackNotTold = "owed" | "before_notices";

/** The confirmation of the fix: who and when, or that nobody did within the window and Forge did. */
export interface FeedbackVerifiedView {
	at: string;
	how: "person" | "automatic";
	/** Who confirmed it; null when Forge did after the window. */
	by: string | null;
	byName: string | null;
	/** The reporter, when they are the one who confirmed it. */
	byReporter: boolean;
	reason: string | null;
	says: { reason: Said | null };
}

export interface FeedbackView extends FeedbackSummary {
	/** Set once the item is verified. */
	verified: FeedbackVerifiedView | null;
	/** While it reads resolved: when Forge verifies it if nobody has, and the window that dates it. */
	autoVerify: { at: string; windowDays: number } | null;
	/** Null until the work that carries the item has shipped (phase resolved or verified on an issue route). */
	shipNotice: FeedbackShipNotice | null;
	body: string | null;
	whereSeen: string | null;
	duplicateOf: string | null;
	duplicates: string[];
	source: FeedbackSourceView | null;
	decisions: FeedbackDecisionView[];
	attachments: FeedbackAttachmentView[];
	/** Everyone who reported it: its own reporter first, then the reporters of the duplicates merged into it. */
	reporters: FeedbackReporterView[];
	/** Messages sent to reporters, and the internal notes the viewer may read, oldest first. */
	messages: FeedbackMessageView[];
	clarification: {
		id: string;
		status: string;
		prompt: string | null;
		answer: string | null;
	} | null;
	/** Proposed triage suggestions waiting on a person. */
	openSuggestions: number;
	/** What the viewer may do now; a refusal still names why when they try anyway. */
	can: {
		triage: boolean;
		verify: boolean;
		reopen: boolean;
		askVerify: boolean;
		redact: boolean;
		/** Correct what the item is about, at any phase; never on an item core filed about a contract version. */
		retarget: boolean;
		/** Accept it unrouted, or park it: while it reads new or reopened. */
		accept: boolean;
		snooze: boolean;
		/** Send a message to its reporters. */
		message: boolean;
		/** Tell its reporters now that the work shipped: a shipped item nothing told yet, with a reporter a bell reaches. */
		tellShipped: boolean;
		/** Write an internal note, which no reporter is ever sent. */
		note: boolean;
		/** Add an attachment: a project writer, while the reporter's data stands. */
		attach: boolean;
	};
	sensitive: boolean;
}

export interface FeedbackResponse {
	feedback: FeedbackView;
}

export interface FeedbackListResponse {
	feedback: FeedbackSummary[];
	counts: Record<FeedbackAttentionGroup, number>;
	/** Shipped items whose reporter nothing told, counted apart: owed a relay, or shipped before release notices existed (since `noticesBegan`). */
	untold: { owed: number; beforeNotices: number; noticesBegan: string | null };
	sensitive: boolean;
}

export interface SimilarFeedbackResponse {
	/** `ok`, no vector row yet (`not_embedded`), or the item's own embedding status, never collapsed. */
	status:
		| "ok"
		| "not_embedded"
		| "provider_not_configured"
		| "failed"
		| "withheld_by_policy";
	message?: string;
	model?: string;
	hits: {
		key: string;
		title: string;
		phase: FeedbackPhase;
		similarity: number;
	}[];
}

export interface FeedbackPromoteEffect {
	feedback: string;
	agentReport: string;
	copied: ("title" | "body")[];
}

/** What a triage accept wrote, read back for the caller. */
export interface FeedbackTriageEffect {
	feedback: string;
	route: FeedbackTriageRoute;
	/** What carries the route by key, every issue of an issue route; none for a decline or an answer. */
	carriers: string[];
}

/** A feedback item's key, `FB-<seq>`. */
export const feedbackKey = (seq: number) => `FB-${seq}`;
