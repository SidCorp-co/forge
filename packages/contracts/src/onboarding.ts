// one declaration of the onboarding and questionnaire vocabulary (workflow project-onboarding
// rev 1, ISS-63): core's table CHECKs, REST, MCP, the BA door and the web all import these values,
// the request schemas and the response shapes from here, so no surface names a state another does
// not know.

import { z } from "zod";
import type {
	DataEgressRefusalCode,
	SensitiveDataLevel,
} from "./data-policy.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import type { PermissionRefusalCode } from "./permissions.js";
import type { RunWaitingOn } from "./run-standing.js";

/** The onboarding thread's status, as the conversation list and the dashboard hint show it. */
export const ONBOARDING_STATUSES = [
	"in_progress",
	"waiting_on_you",
	"done",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STATUS_TONES: Record<
	OnboardingStatus,
	IssueStatusTone
> = {
	in_progress: "run",
	waiting_on_you: "you",
	done: "done",
};

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
	in_progress: "In progress",
	waiting_on_you: "Waiting on you",
	done: "Done",
};

/** The same three values read as any conversation's status (`assistant/thread-marks.ts:threadMarks`). */
export const THREAD_STATUS_HINTS: Record<OnboardingStatus, string> = {
	in_progress: "in_progress: the agent is working on the last message",
	waiting_on_you: "waiting_on_you: a question or a batch waits on you",
	done: "done: nothing in this thread waits on you or on the agent",
};

/** Which analysis an onboarding job runs: the first read of the code, or the turn after a submit. */
export const ONBOARDING_JOB_PHASES = ["analyse", "revise"] as const;
export type OnboardingJobPhase = (typeof ONBOARDING_JOB_PHASES)[number];

/** A batch's life: answered once (submitted), parked (skipped, still answerable) or replaced. */
export const QUESTIONNAIRE_STATUSES = [
	"open",
	"submitted",
	"skipped",
	"superseded",
] as const;
export type QuestionnaireStatus = (typeof QUESTIONNAIRE_STATUSES)[number];
/** The three groups a batch is read in, in this order. */
export const QUESTIONNAIRE_GROUPS = [
	"question",
	"clarification",
	"recommendation",
] as const;
export type QuestionnaireGroup = (typeof QUESTIONNAIRE_GROUPS)[number];

export const QUESTIONNAIRE_GROUP_LABELS: Record<QuestionnaireGroup, string> = {
	question: "Questions",
	clarification: "Needs clarification",
	recommendation: "Recommendations",
};

/** How an item is answered: one option, several, a short text, or accept / reject. */
const QUESTIONNAIRE_CONTROLS = [
	"choice",
	"multi",
	"text",
	"accept_reject",
] as const;
/** An item's own state, read from its agent_questions row. */
export const QUESTIONNAIRE_ITEM_STATES = ["open", "answered", "void"] as const;
export type QuestionnaireItemState = (typeof QUESTIONNAIRE_ITEM_STATES)[number];
/** At most this many rounds per onboarding (reset by a re-analysis) or per requirement room. */
export const QUESTIONNAIRE_MAX_ROUNDS = 3;
/** At most this many items in one batch; the trials landed at 15. */
export const QUESTIONNAIRE_MAX_ITEMS = 15;
/** A batch left open this many days raises the dashboard hint to attention. */
export const QUESTIONNAIRE_DUE_DAYS = 7;

const ONBOARDING_REFUSAL_CODES = [
	"ONBOARDING_ALREADY_RUNNING",
	"ONBOARDING_ALREADY_STARTED",
	"ONBOARDING_NOT_STARTED",
	"ONBOARDING_DONE",
	"ONBOARDING_DESIGN_UNKNOWN",
	"ONBOARDING_DATA_FLOW_MISSING",
	"ONBOARDING_CITE_UNANSWERED",
	"ONBOARDING_CITE_REVISION_UNKNOWN",
	"ONBOARDING_CITE_REVISION_TWICE",
	"ONBOARDING_CITE_SUGGESTION_UNKNOWN",
] as const;
export type OnboardingRefusalCode = (typeof ONBOARDING_REFUSAL_CODES)[number];

export const QUESTIONNAIRE_REFUSAL_CODES = [
	"QUESTIONNAIRE_SUPERSEDED",
	"QUESTIONNAIRE_ALREADY_ANSWERED",
	"QUESTIONNAIRE_ALREADY_OPEN",
	"QUESTIONNAIRE_ROUNDS_EXHAUSTED",
	"QUESTIONNAIRE_ITEM_INVALID",
	"QUESTIONNAIRE_ITEM_ANSWERED_BEFORE",
	"QUESTIONNAIRE_RECOMMENDATION_REJECTED",
	"QUESTIONNAIRE_ITEM_UNKNOWN",
	"QUESTIONNAIRE_ANSWER_INVALID",
	"QUESTIONNAIRE_NOTHING_ANSWERED",
	"CLARIFICATION_ALREADY_OPEN",
	"QUESTIONNAIRE_THREAD_INVALID",
	"QUESTIONNAIRE_REFUSED",
] as const;
export type QuestionnaireRefusalCode =
	(typeof QUESTIONNAIRE_REFUSAL_CODES)[number];

export interface OnboardingRefusal {
	/** CONTENT_EGRESS_FORBIDDEN: an agent read of a no_egress project's answers (ISS-59's one guard). */
	code:
		| OnboardingRefusalCode
		| QuestionnaireRefusalCode
		| DataEgressRefusalCode
		| PermissionRefusalCode;
	path: string;
	detail: string;
}

const itemId = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9_-]{0,39}$/,
		"an item id is 1-40 of a-z, 0-9, _ and -, stable across rounds",
	);

const questionnaireOptionSchema = z.strictObject({
	id: itemId,
	label: z.string().trim().min(1).max(200),
});

/** One item as the agent posts it; the rules in core check what the shape cannot. */
export const questionnaireItemSchema = z.strictObject({
	id: itemId,
	group: z.enum(QUESTIONNAIRE_GROUPS),
	control: z.enum(QUESTIONNAIRE_CONTROLS),
	prompt: z.string().trim().min(3).max(500),
	options: z.array(questionnaireOptionSchema).max(8).optional(),
	/** The option id inferred from the code: marked, never chosen until a person picks it. */
	inferredDefault: itemId.optional(),
	placeholder: z.string().max(120).optional(),
	/** Why we ask, in a sentence or two. */
	why: z.string().trim().min(3).max(600),
	/** `file:symbol`, or a Forge record citation (REQ-1 BC-6, ISS-4, FB-2, a design step). */
	evidence: z.array(z.string().trim().min(3).max(300)).min(1).max(5),
	/** The designs it shapes, by workflow id or flow slug. */
	affects: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
	/** A question the last answers raised, shown with a New badge. */
	isNew: z.boolean().optional(),
});
export type QuestionnaireItem = z.infer<typeof questionnaireItemSchema>;

/** `POST /api/projects/:id/onboarding/questionnaires` and the BA door's tool. */
export const postQuestionnaireRequestSchema = z.strictObject({
	title: z.string().trim().min(1).max(120),
	intro: z.string().trim().max(2_000).optional(),
	items: z.array(questionnaireItemSchema).min(1).max(QUESTIONNAIRE_MAX_ITEMS),
});
export type PostQuestionnaireRequest = z.infer<
	typeof postQuestionnaireRequestSchema
>;
export const POST_QUESTIONNAIRE_SHAPE = `{ title, intro?, items: [{ id, group: ${QUESTIONNAIRE_GROUPS.join(" | ")}, control: ${QUESTIONNAIRE_CONTROLS.join(" | ")}, prompt, options?: [{ id, label }], inferredDefault?, placeholder?, why, evidence: [file:symbol | record], affects?, isNew? }] } (1-${QUESTIONNAIRE_MAX_ITEMS} items)`;

/** One answer: the field that fits the item's control, and nothing else. */
export const questionnaireAnswerSchema = z.strictObject({
	itemId,
	choice: itemId.optional(),
	choices: z.array(itemId).min(1).max(8).optional(),
	text: z.string().trim().min(1).max(2_000).optional(),
	decision: z.enum(["accept", "reject"]).optional(),
});
export type QuestionnaireAnswer = z.infer<typeof questionnaireAnswerSchema>;

/** `POST /api/projects/:id/questionnaires/:batchId/answers` — the one submit, partial allowed. */
export const submitAnswersRequestSchema = z.strictObject({
	answers: z.array(questionnaireAnswerSchema).max(QUESTIONNAIRE_MAX_ITEMS),
	/** Skip for now: a recorded outcome; the batch stays answerable and nothing more is asked. */
	skip: z.boolean().optional(),
});
export const SUBMIT_ANSWERS_SHAPE =
	"{ answers: [{ itemId, choice? | choices? | text? | decision?: accept | reject }], skip? }";

export const reanalyzeRequestSchema = z.strictObject({
	reason: z.string().trim().max(2_000).optional(),
});
export const REANALYZE_SHAPE = "{ reason? }";

/** What the person asks the analysis job for, in their words: posted in the thread and carried in the job's brief. */
export const ONBOARDING_REQUEST_MAX = 4_000;

/** `POST /api/projects/:id/onboarding/start`. */
export const startRequestSchema = z.strictObject({
	request: z.string().trim().min(1).max(ONBOARDING_REQUEST_MAX).optional(),
});
export const START_SHAPE = `{ request?: what the drafts should cover, 1-${ONBOARDING_REQUEST_MAX} characters }`;

/** A person's message in the onboarding thread, as the job that drafts the designs reads it. */
export interface OnboardingThreadRequest {
	at: string;
	author: string | null;
	text: string;
}

/**
 * Where an answered item landed: the proposed design revision that cites it, or, for an accepted
 * recommendation, the suggestion it became. Recorded on the item, never applied to a design.
 */
export const onboardingCiteSchema = z.union([
	z.strictObject({
		itemId,
		workflowId: z.uuid(),
		revision: z.number().int().min(1),
	}),
	z.strictObject({ itemId, suggestionId: z.uuid() }),
]);
export type OnboardingCite = z.infer<typeof onboardingCiteSchema>;

/** An agent's message in the thread: prose, and the designs it names with live status. */
export const postUpdateRequestSchema = z.strictObject({
	text: z.string().trim().min(1).max(8_000),
	designs: z
		.strictObject({
			heading: z.string().trim().min(1).max(120),
			workflowIds: z.array(z.uuid()).min(1).max(20),
			/** Draw an Approve link beside each: the "Designs ready for your approval" message. */
			approve: z.boolean().optional(),
		})
		.optional(),
	/** The items each revision or suggestion of this update came from (answer-lands, revise). */
	cites: z.array(onboardingCiteSchema).max(60).optional(),
});
export type PostUpdateRequest = z.infer<typeof postUpdateRequestSchema>;
export const POST_UPDATE_SHAPE =
	"{ text, designs?: { heading, workflowIds: [uuid], approve? }, cites?: [{ itemId, workflowId, revision } | { itemId, suggestionId }] }";

export const markDoneRequestSchema = z.strictObject({
	text: z.string().trim().min(1).max(8_000).optional(),
});
export const MARK_DONE_SHAPE = "{ text? }";

/** An item as every reader sees it, with its row's state and the answer it got. */
export interface QuestionnaireItemView extends QuestionnaireItem {
	questionId: string;
	state: QuestionnaireItemState;
	answer: Omit<QuestionnaireAnswer, "itemId"> | null;
	answeredBy: string | null;
	answeredAt: string | null;
}

export interface QuestionnaireView {
	id: string;
	conversationId: string;
	onboardingId: string | null;
	requirementId: string | null;
	/** The onboarding whose first-requirements room asked; the third arm of a batch's thread. */
	firstRequirementsOf: string | null;
	title: string;
	intro: string | null;
	round: number;
	maxRounds: number;
	status: QuestionnaireStatus;
	items: QuestionnaireItemView[];
	answered: number;
	open: number;
	postedBy: string;
	postedAt: string;
	submittedBy: string | null;
	submittedAt: string | null;
	skippedAt: string | null;
	supersededAt: string | null;
	supersededBy: string | null;
	messageId: string | null;
	answersMessageId: string | null;
	/** The project's data policy: above `off` the card warns that answers are product information only. */
	sensitiveData: SensitiveDataLevel;
}

export interface QuestionnaireResponse {
	questionnaire: QuestionnaireView;
}

/** A questionnaire item that shaped a design: it names the design in `affects`, or a revision cites it. */
export interface OnboardingLinkedItem {
	itemId: string;
	questionId: string;
	group: QuestionnaireGroup;
	prompt: string;
	state: QuestionnaireItemState;
	/** The revision of this design that cites the item, if one does. */
	citedRevision: number | null;
}

export interface OnboardingDesignView {
	workflowId: string;
	flow: string;
	title: string;
	template: string | null;
	designStatus: string | null;
	revision: number;
	approvedRevision: number | null;
	/** Each item's latest round only. */
	linkedItems: OnboardingLinkedItem[];
	/** Once every round is sent: the linked items still open, listed on the design as open questions. */
	openQuestions: OnboardingLinkedItem[];
}

export interface OnboardingJobView {
	id: string;
	phase: OnboardingJobPhase;
	status: string;
	queuedAt: string;
	dispatchedAt: string | null;
	finishedAt: string | null;
	/** The job's run as the run read model reads it while it is live; null once it is over. */
	waitingOn: RunWaitingOn | null;
}

/** A thread's answerable batch and its due rule (project-onboarding `expect-answers`, `unanswered`). */
export interface OpenQuestionnaireBatch {
	id: string;
	round: number;
	open: number;
	postedAt: string;
	/** postedAt plus QUESTIONNAIRE_DUE_DAYS. */
	dueAt: string;
	/** Past dueAt: one line on the dashboard and on the chat, never a blocker. */
	overdue: boolean;
	waitingDays: number;
}

export interface OnboardingView {
	id: string;
	projectId: string;
	conversationId: string;
	status: OnboardingStatus;
	roundsSent: number;
	maxRounds: number;
	startedBy: string;
	startedAt: string;
	reanalyzedAt: string | null;
	doneAt: string | null;
	designs: OnboardingDesignView[];
	openBatch: OpenQuestionnaireBatch | null;
	job: OnboardingJobView | null;
	sensitiveData: boolean;
}

/** The dashboard's one line: never a blocker, gone once every onboarding design is approved. */
export interface OnboardingHint {
	tone: IssueStatusTone | "attention";
	lead: string;
	text: string;
	action: "start" | "continue" | "open" | "reanalyze";
	actionLabel: string;
	/** Whether a person may ask for a re-analysis now: an onboarding exists and no job of it is live. */
	mayReanalyze: boolean;
}

/** project-onboarding `req-result`: whether the BA assistant suggested first requirements; `pending` while it has not answered. */
export interface OnboardingFirstRequirements {
	status: "pending" | "suggested" | "none";
	/** The first-requirements room the BA assistant works in. */
	conversationId: string;
	/** Live requirement drafts (proposed or accepted) on the onboarding's designs. */
	suggested: number;
	/** The BA's answerable questionnaire in the room, due QUESTIONNAIRE_DUE_DAYS after it was sent. */
	openBatch: OpenQuestionnaireBatch | null;
}

export interface OnboardingStateResponse {
	onboarding: OnboardingView | null;
	hint: OnboardingHint | null;
	/** Null until every onboarding design is approved and the first-requirements case is open. */
	firstRequirements: OnboardingFirstRequirements | null;
}

export interface OnboardingResponse {
	onboarding: OnboardingView;
}
