// cm:why one declaration of the onboarding and questionnaire vocabulary (workflow project-onboarding
// rev 1, ISS-63): core's table CHECKs, REST, MCP, the BA door and the web all import these values,
// the request schemas and the response shapes from here, so no surface names a state another does
// not know.

import { z } from "zod";
import type { DataEgressRefusalCode, SensitiveDataLevel } from "./data-policy.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";

/** The onboarding thread's status, as the conversation list and the dashboard hint show it. */
export const ONBOARDING_STATUSES = [
	"in_progress",
	"waiting_on_you",
	"done",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STATUS_TONES: Record<OnboardingStatus, IssueStatusTone> =
	{
		in_progress: "run",
		waiting_on_you: "you",
		done: "done",
	};

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
	in_progress: "In progress",
	waiting_on_you: "Waiting on you",
	done: "Done",
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

export const QUESTIONNAIRE_STATUS_TONES: Record<
	QuestionnaireStatus,
	IssueStatusTone
> = {
	open: "you",
	submitted: "done",
	skipped: "neutral",
	superseded: "neutral",
};

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
export const QUESTIONNAIRE_CONTROLS = [
	"choice",
	"multi",
	"text",
	"accept_reject",
] as const;
export type QuestionnaireControl = (typeof QUESTIONNAIRE_CONTROLS)[number];

/** An item's own state, read from its agent_questions row. */
export const QUESTIONNAIRE_ITEM_STATES = ["open", "answered", "void"] as const;
export type QuestionnaireItemState = (typeof QUESTIONNAIRE_ITEM_STATES)[number];

export const QUESTIONNAIRE_ITEM_STATE_TONES: Record<
	QuestionnaireItemState,
	IssueStatusTone
> = {
	open: "you",
	answered: "ready",
	void: "neutral",
};

/** At most this many rounds per onboarding (reset by a re-analysis) or per requirement room. */
export const QUESTIONNAIRE_MAX_ROUNDS = 3;
/** At most this many items in one batch; the trials landed at 15. */
export const QUESTIONNAIRE_MAX_ITEMS = 15;
/** A batch left open this many days raises the dashboard hint to attention. */
export const QUESTIONNAIRE_DUE_DAYS = 7;

export const ONBOARDING_REFUSAL_CODES = [
	"ONBOARDING_ALREADY_RUNNING",
	"ONBOARDING_ALREADY_STARTED",
	"ONBOARDING_NOT_STARTED",
	"ONBOARDING_DONE",
	"ONBOARDING_ACT_FORBIDDEN",
	"ONBOARDING_WRITE_FORBIDDEN",
	"ONBOARDING_DESIGN_UNKNOWN",
	"ONBOARDING_DATA_FLOW_MISSING",
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
	"QUESTIONNAIRE_SUBMIT_FORBIDDEN",
	"QUESTIONNAIRE_POST_FORBIDDEN",
	"CLARIFICATION_ALREADY_OPEN",
] as const;
export type QuestionnaireRefusalCode =
	(typeof QUESTIONNAIRE_REFUSAL_CODES)[number];

export interface OnboardingRefusal {
	/** CONTENT_EGRESS_FORBIDDEN: an agent read of a no_egress project's answers (ISS-59's one guard). */
	code: OnboardingRefusalCode | QuestionnaireRefusalCode | DataEgressRefusalCode;
	path: string;
	detail: string;
}

const itemId = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9_-]{0,39}$/,
		"an item id is 1-40 of a-z, 0-9, _ and -, stable across rounds",
	);

export const questionnaireOptionSchema = z.strictObject({
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
export type SubmitAnswersRequest = z.infer<typeof submitAnswersRequestSchema>;
export const SUBMIT_ANSWERS_SHAPE =
	"{ answers: [{ itemId, choice? | choices? | text? | decision?: accept | reject }], skip? }";

export const reanalyzeRequestSchema = z.strictObject({
	reason: z.string().trim().max(2_000).optional(),
});
export const REANALYZE_SHAPE = "{ reason? }";

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
});
export type PostUpdateRequest = z.infer<typeof postUpdateRequestSchema>;
export const POST_UPDATE_SHAPE =
	"{ text, designs?: { heading, workflowIds: [uuid], approve? } }";

export const markDoneRequestSchema = z.strictObject({
	text: z.string().trim().min(1).max(8_000).optional(),
});
export const MARK_DONE_SHAPE = "{ text? }";

/** The canonical message blocks onboarding adds beside text / tool / todos / thinking. */
export const QUESTIONNAIRE_BLOCK_TYPES = [
	"questionnaire",
	"questionnaire_answers",
	"designs",
] as const;
export type QuestionnaireBlockType = (typeof QUESTIONNAIRE_BLOCK_TYPES)[number];

export interface DesignsBlockData {
	heading: string;
	workflowIds: string[];
	approve?: boolean;
}

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

export interface OnboardingDesignView {
	workflowId: string;
	flow: string;
	title: string;
	template: string | null;
	designStatus: string | null;
	revision: number;
	approvedRevision: number | null;
}

export interface OnboardingJobView {
	id: string;
	phase: OnboardingJobPhase;
	status: string;
	queuedAt: string;
	dispatchedAt: string | null;
	finishedAt: string | null;
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
	openBatch: { id: string; round: number; open: number; postedAt: string } | null;
	job: OnboardingJobView | null;
	sensitiveData: boolean;
}

/** The dashboard's one line: never a blocker, gone once every onboarding design is approved. */
export interface OnboardingHint {
	tone: IssueStatusTone | "attention";
	lead: string;
	text: string;
	action: "start" | "continue" | "open";
	actionLabel: string;
}

export interface OnboardingStateResponse {
	onboarding: OnboardingView | null;
	hint: OnboardingHint | null;
}

export interface OnboardingResponse {
	onboarding: OnboardingView;
}
