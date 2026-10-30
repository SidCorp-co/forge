import { PROBE_REFUSAL_CODES } from "./criterion-probes.js";
import {
	DESIGN_CHECK_CODES,
	VERDICT_JUDGE_REFUSAL_CODES,
} from "./issue-design.js";
import type { RefusalStatuses } from "./refusal.js";
import { STOREFRONT_DRAFT_REFUSAL_CODES } from "./verdict-identity.js";

export type { ReleaseNotes, ReleaseNotesSection } from "./release-notes.js";

// Rule refusals an issue write answers in the refusal envelope (packages/contracts/src/refusal.ts).

export const CRITERIA_REFUSAL_CODES = [
	"CRITERIA_REFUSED",
	"CRITERIA_TEXT_UNPARSEABLE",
	"CRITERIA_LOCKED",
	"CRITERIA_INPUT_INVALID",
	"CRITERIA_TRACE_INVALID",
	"CRITERIA_TRACE_NOT_LEADING",
	"CRITERIA_TRACE_UNRESOLVED",
	"CRITERIA_TRACE_DROPPED",
	"CRITERIA_TRACE_DUPLICATE",
	"CRITERIA_RENUMBER_AMBIGUOUS",
	/** A trace taking up a criterion that stands failed on the issue that delivered it, named (REQ-74 BC-3). */
	"CRITERION_FAILURE_OWNED",
	/** A single-criterion write naming no live criterion of the issue, with the ones it has. */
	"CRITERION_UNKNOWN",
	/** A wording correction that changes the criterion's trace, which only the whole-list write may. */
	"CRITERION_REWORD_TRACE",
] as const;
export type CriteriaRefusalCode = (typeof CRITERIA_REFUSAL_CODES)[number];

export const VERDICT_REFUSAL_CODES = [
	"VERDICT_REFUSED",
	"VERDICT_VALUE_UNKNOWN",
	"VERDICT_SKIP_REASON_REQUIRED",
	"VERDICT_CLIP_REQUIRED",
	/** A pass, short or fail on a server-side criterion citing no file attached to the issue (REQ-36 BC-21). */
	"VERDICT_CAPTURE_REQUIRED",
	"VERDICT_IDENTITY_REQUIRED",
	"VERDICT_COMMIT_NOT_FULL",
	"VERDICT_RUNTIME_NOT_FULL",
	"VERDICT_RUNTIME_UNOBSERVED",
	"VERDICT_DESIGN_SHAPE",
	"VERDICT_CONTRACT_SHAPE",
	"VERDICT_CRITERION_UNKNOWN",
	"VERDICT_DESIGN_UNKNOWN",
	"VERDICT_DESIGN_UNAPPROVED",
	"VERDICT_CONTRACT_UNKNOWN",
	"VERDICT_SECRET",
	"VERDICT_RUN_UNKNOWN",
	"VERDICT_SESSION_NOT_ADMITTED",
	...VERDICT_JUDGE_REFUSAL_CODES,
	...STOREFRONT_DRAFT_REFUSAL_CODES,
	...PROBE_REFUSAL_CODES,
] as const;
export type VerdictRefusalCode = (typeof VERDICT_REFUSAL_CODES)[number];

export const ATTRIBUTE_REFUSAL_CODES = [
	"ATTRIBUTE_REFUSED",
	"UNREGISTERED_KEY",
	"WRONG_TYPE",
	"OBLIGATION_UNOWNED",
	"EMPTY_TEXT",
	"SOURCE_COMMENT_NOT_FOUND",
	"SOURCE_COMMENT_OFF_ISSUE",
] as const;
export type AttributeRefusalCode = (typeof ATTRIBUTE_REFUSAL_CODES)[number];

export const COMMIT_LANDING_REFUSAL_CODES = [
	"COMMIT_NOT_IN_REPOSITORY",
	"COMMIT_NOT_THIS_ISSUE",
	"COMMIT_NOT_LANDED",
	"COMMIT_UNVERIFIED",
] as const;
export type CommitLandingRefusalCode =
	(typeof COMMIT_LANDING_REFUSAL_CODES)[number];

export const MERGE_REFUSAL_CODES = [
	"MERGE_MARK_REFUSED",
	"NO_WORK_EVIDENCE",
	"UNMARK_REQUIRES_NOT_CLOSED",
	"LANDING_REQUIRED",
	"LANDING_NOT_THIS_SHAPE",
	"MARK_ALREADY_STANDS",
	"ARTIFACTS_NOT_THIS_SHAPE",
	"ARTIFACTS_NOT_DESIGN",
	"ARTIFACT_CARRIER_UNKNOWN",
	"ARTIFACT_CARRIER_SELF",
	"ARTIFACT_CARRIER_SHIPPED",
	"ARTIFACT_CARRIER_DESIGN",
	"CHANGED_PATHS_NOT_THIS_SHAPE",
	"CHANGED_PATHS_UNMATCHED",
	"TARGET_REQUIRED",
	"PROJECT_DOCUMENT_NOT_FOUND",
	"NO_PULL_REQUEST",
	"PROJECTION_EMPTY",
	"MERGE_REFUSED",
	"MERGE_REQUESTER_MISSING",
	"MERGE_RUN_NOT_FOUND",
	"MERGE_RUN_OF_ANOTHER_PROJECT",
	"NO_BINDING",
	"MERGE_CHECK_MISSING",
	"MERGE_REVIEW_MISSING",
	"PATTERN_ENTRY_MISSING",
	/** A change request of a change-request release merged before the release is approved (REQ-63 BC-2). */
	"RELEASE_MERGE_NOT_APPROVED",
	/** A change request merged before one its release declares ahead of it (REQ-63 BC-2). */
	"RELEASE_MERGE_OUT_OF_ORDER",
	/** A change request on a change-request project merged outside any release (REQ-63 BC-2). */
	"RELEASE_MERGE_UNRELEASED",
	/** A change request on a promotion project whose target branch Forge cannot read, so whether it is a release step is unknown (REQ-63 BC-11). */
	"RELEASE_MERGE_TARGET_UNREAD",
	/** A change request whose head moved since its release was cut and accepted at another (REQ-71 BC-7). */
	"RELEASE_MERGE_HEAD_MOVED",
	/** A mark on a change-request project that names no host merge: only the host's merge of a change request lands there (REQ-71). */
	"MARK_NOT_A_HOST_MERGE",
	/** The host a change-request project's mark is checked against could not be read, so the mark is not taken unchecked (REQ-71). */
	"MARK_HOST_UNREACHABLE",
	/** A mark's `commit` that is not the whole 40-character sha, which is the only claim a release can place (REQ-71). */
	"COMMIT_NOT_WHOLE",
	/** A named adoption the project's interface or links are not built against (REQ-5 BC-18). */
	"ADOPTION_NOT_RECORDED",
	/** An adoption mark on an issue that carries code, or names a commit, paths or a landing beside it (REQ-5 BC-18). */
	"ADOPTION_BESIDE_CODE",
	/** An `adoption` artifact sent by hand: only `adoptions`, which Forge reads, stamps one (REQ-5 BC-17). */
	"ARTIFACTS_ADOPTION_BY_HAND",
	/** `adoptions` sent to an issue already marked merged on something else, which would drop them unwritten. */
	"ADOPTION_MARK_HELD",
	...COMMIT_LANDING_REFUSAL_CODES,
] as const;
export type MergeRefusalCode = (typeof MERGE_REFUSAL_CODES)[number];

export const ARCHIVE_REFUSAL_CODES = [
	"ARCHIVE_REFUSED",
	"ARCHIVE_KEY_UNKNOWN",
	"ARCHIVE_STATUS_NOT_TERMINAL",
	"ARCHIVE_ISSUE_NOT_TERMINAL",
	"ARCHIVE_EDGE_LOAD_BEARING",
] as const;
export type ArchiveRefusalCode = (typeof ARCHIVE_REFUSAL_CODES)[number];

export const ISSUE_ATTACHMENT_REFUSAL_CODES = [
	"ATTACHMENT_REFUSED",
	"MIME_NOT_ALLOWED",
	"FILE_TOO_LARGE",
	"EMPTY_FILE",
	"INVALID_NAME",
	"INVALID_BASE64",
	"PAYLOAD_TOO_LARGE",
	"ATTACHMENT_NAME_TAKEN",
] as const;
export type IssueAttachmentRefusalCode =
	(typeof ISSUE_ATTACHMENT_REFUSAL_CODES)[number];

export const DEPENDENCY_REFUSAL_CODES = [
	"DEPENDENCY_REFUSED",
	"SELF_DEP",
	"CROSS_PROJECT",
	"CYCLE_DETECTED",
	"CYCLE_DEPTH_EXCEEDED",
	"ISSUE_ARCHIVED",
	"EDGE_MISMATCH",
] as const;
export type DependencyRefusalCode = (typeof DEPENDENCY_REFUSAL_CODES)[number];

export const LABEL_ATTACH_REFUSAL_CODES = [
	"LABELS_REFUSED",
	"INVALID_LABELS",
	"PRIMARY_NOT_MODULE",
	"MULTIPLE_PRIMARY",
] as const;
export type LabelAttachRefusalCode =
	(typeof LABEL_ATTACH_REFUSAL_CODES)[number];

export const ISSUE_CREATE_REFUSAL_CODES = [
	"ISSUE_CREATE_REFUSED",
	"INVALID_STATUS",
	"INVALID_DETECTOR_KEY",
	"CHAT_FILES_FEEDBACK_NOT_ISSUES",
	"MCP_FILES_FEEDBACK_NOT_ISSUES",
] as const;
export type IssueCreateRefusalCode =
	(typeof ISSUE_CREATE_REFUSAL_CODES)[number];

/**
 * A chat door's credential is refused an issue whoever holds it, and so is an MCP client: each
 * files Feedback or a Requirement, and issues are born from those.
 */
export const ISSUE_CREATE_REFUSAL_STATUSES = {
	CHAT_FILES_FEEDBACK_NOT_ISSUES: 403,
	MCP_FILES_FEEDBACK_NOT_ISSUES: 403,
} as const satisfies RefusalStatuses<IssueCreateRefusalCode>;

export const ISSUE_TAKE_REFUSAL_CODES = [
	"ISSUE_TAKE_REFUSED",
	"ISSUE_BLOCKED",
	"ISSUE_LEASE_HELD",
	"ISSUE_NOT_FOUND",
	"ISSUE_LEASE_KEY_SHAPE",
	"ISSUE_LEASE_KEY_UNKNOWN_PREFIX",
	"ISSUE_LEASE_KEY_PROJECT_MISMATCH",
	"ISSUE_SCOPE_HELD",
	"ISSUE_AT_REST",
] as const;
export type IssueTakeRefusalCode = (typeof ISSUE_TAKE_REFUSAL_CODES)[number];
export const ISSUE_TAKE_REFUSAL_STATUSES = {
	ISSUE_LEASE_HELD: 409,
	ISSUE_NOT_FOUND: 404,
	ISSUE_LEASE_KEY_SHAPE: 400,
	ISSUE_LEASE_KEY_UNKNOWN_PREFIX: 404,
	ISSUE_LEASE_KEY_PROJECT_MISMATCH: 400,
} as const satisfies RefusalStatuses<IssueTakeRefusalCode>;

export const ISSUE_UPDATE_REFUSAL_CODES = [
	"ISSUE_UPDATE_REFUSED",
	"SESSION_CONTEXT_DROPS_UNREAD_KEYS",
	"SESSION_CONTEXT_MISMATCH",
	"BRANCH_SELF_REFERENCE",
	"ASSIGNEE_NOT_MEMBER",
	"STATUS_MOVES_BY_TRANSITION",
	"PATTERN_REVIEW_PENDING",
	"PATTERN_RETURNED",
	"ISSUE_SCOPE_HELD",
	"PLAN_APPROVAL_PENDING",
	"PLAN_REQUIRED",
	...DESIGN_CHECK_CODES,
] as const;
export type IssueUpdateRefusalCode =
	(typeof ISSUE_UPDATE_REFUSAL_CODES)[number];

export const ISSUE_UPDATE_REFUSAL_STATUSES = {
	STATUS_MOVES_BY_TRANSITION: 400,
} as const satisfies RefusalStatuses<IssueUpdateRefusalCode>;
