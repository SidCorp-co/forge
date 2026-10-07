// one declaration of what a comment may sit on and what a decision must carry (ISS-83): core's
// CHECKs, REST, MCP and the web read these values, so no surface can name a scope another does not know

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import { COMMENT_INTENTS, type CommentIntent } from "./record-events.js";
import { REASON_TEXT_MAX } from "./reason-text.js";
import { NODE_DECISION_SHAPE, nodeDecisionSchema } from "./workflow-health.js";

export const COMMENT_SCOPES = [
	"issue",
	"requirement",
	"workflow",
	"feedback",
] as const;

export type CommentScope = (typeof COMMENT_SCOPES)[number];

export const ENTITY_COMMENT_SCOPES = [
	"requirement",
	"workflow",
	"feedback",
] as const;

export type EntityCommentScope = (typeof ENTITY_COMMENT_SCOPES)[number];

export const COMMENT_EVENT_KINDS = ["posted", "edited"] as const;
export const COMMENT_REFUSAL_CODES = [
	"COMMENT_REFUSED",
	"COMMENT_INTENT_UNKNOWN",
	"COMMENT_SCOPE_INVALID",
	"COMMENT_DECISION_REQUIRED",
	"COMMENT_DECISION_INTENT_MISMATCH",
	"COMMENT_BODY_REQUIRED",
	"COMMENT_BODY_INVALID",
	"COMMENT_PARENT_MISMATCH",
	"COMMENT_DEPTH_EXCEEDED",
	...PERMISSION_REFUSAL_CODES,
	"COMMENT_RECORD_KEPT",
	"COMMENT_DECISION_NODE_SCOPE",
	"WORKFLOW_NODE_UNKNOWN",
	"WORKFLOW_NODE_AMBIGUOUS",
] as const;

export type CommentRefusalCode = (typeof COMMENT_REFUSAL_CODES)[number];

export interface CommentRefusal {
	code: CommentRefusalCode;
	path: string;
	detail: string;
}

const COMMENT_BODY_MAX = 64_000;

export {
	REASON_LINE_MAX,
	REASON_NOTE_MAX,
	REASON_PARAGRAPH_MAX,
	REASON_SENTENCE_MAX,
	REASON_TEXT_MAX,
} from "./reason-text.js";

const DECISIONS_LIST_MAX = 200;

const text = (max: number) => z.string().trim().min(1).max(max);

export const decisionFieldsSchema = z.strictObject({
	decision: text(REASON_TEXT_MAX),
	reason: text(REASON_TEXT_MAX),
	options: z.array(text(1_000)).max(20).optional(),
	authority: text(1_000).optional(),
	reversedWhen: text(2_000).optional(),
	/** On a workflow decision only: the step or edge decided, and keep, rewrite or delete (REQ-17 BC-26). */
	node: nodeDecisionSchema.optional(),
});

export type DecisionFields = z.infer<typeof decisionFieldsSchema>;

const DECISION_FIELDS_SHAPE = `{ decision, reason, options?: string[], authority?, reversedWhen?, node?: ${NODE_DECISION_SHAPE} (workflow decisions only) }`;

export const createEntityCommentRequestSchema = z.strictObject({
	intent: z.enum(COMMENT_INTENTS),
	body: z.string().max(COMMENT_BODY_MAX).optional(),
	format: z.enum(["markdown", "html"]).optional(),
	parentId: z.uuid().optional(),
	decision: decisionFieldsSchema.optional(),
});

export type CreateEntityCommentRequest = z.infer<
	typeof createEntityCommentRequestSchema
>;

export const CREATE_ENTITY_COMMENT_SHAPE = `{ intent: ${COMMENT_INTENTS.join(" | ")}, body? (required unless intent is decision), format?: markdown | html, parentId?, decision?: ${DECISION_FIELDS_SHAPE} (required when intent is decision, refused otherwise) }`;

export const editEntityCommentRequestSchema = z.strictObject({
	body: z.string().max(COMMENT_BODY_MAX).optional(),
	format: z.enum(["markdown", "html"]).optional(),
	decision: decisionFieldsSchema.optional(),
});

export type EditEntityCommentRequest = z.infer<
	typeof editEntityCommentRequestSchema
>;

export const EDIT_ENTITY_COMMENT_SHAPE = `{ body?, format?: markdown | html, decision?: ${DECISION_FIELDS_SHAPE} } — at least one; decision only on a decision`;

const ref = z.string().trim().min(1).max(200);

/**
 * The project's decisions, newest first. `requirement` (REQ-n or uuid) keeps those on the
 * requirement and on the issues that deliver it; `workflow` (flow or uuid), `issue` (key or uuid)
 * and `who` (a user uuid) keep those on it or by them; `since` and `until` bound when each was made.
 */
export const listDecisionsQuerySchema = z.strictObject({
	scope: z.enum(COMMENT_SCOPES).optional(),
	limit: z.coerce.number().int().min(1).max(DECISIONS_LIST_MAX).optional(),
	requirement: ref.optional(),
	workflow: ref.optional(),
	issue: ref.optional(),
	who: z.uuid().optional(),
	since: z.iso.date().or(z.iso.datetime()).optional(),
	until: z.iso.date().or(z.iso.datetime()).optional(),
});

export type ListDecisionsQuery = z.infer<typeof listDecisionsQuerySchema>;

export const LIST_DECISIONS_QUERY_SHAPE = `scope? (${COMMENT_SCOPES.join(" | ")}), limit? (1..${DECISIONS_LIST_MAX}), requirement? (REQ-n or uuid), workflow? (flow or uuid), issue? (key or uuid), who? (user uuid), since?, until? (an ISO date or date-time)`;

export interface CommentTargetView {
	scope: CommentScope;
	id: string;
	key: string;
	title: string | null;
}

export interface CommentAuthorView {
	id: string;
	name: string | null;
	agency: "human" | "agent";
}

export interface EntityCommentView {
	id: string;
	target: CommentTargetView;
	intent: CommentIntent;
	body: string | null;
	format: "markdown" | "html";
	decision: DecisionFields | null;
	parentId: string | null;
	author: CommentAuthorView;
	withheld: boolean;
	edited: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface EntityCommentListResponse {
	comments: EntityCommentView[];
	returned: number;
}

export interface EntityCommentResponse {
	comment: EntityCommentView;
}

export interface DecisionListResponse {
	decisions: EntityCommentView[];
	returned: number;
	limit: number;
}
