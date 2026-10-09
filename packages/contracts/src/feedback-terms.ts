// The words a feedback item and its triage checklist share: kind, severity and route, with their
// labels. A leaf module: the checklist registry reads them, and `feedback.ts` re-exports them, so the
// registry imports nothing that imports it back.

/** What the reporter says it is; `contract_change` is filed by core for a breaking version (E3). */
export const FEEDBACK_KINDS = [
	"bug",
	"change_request",
	"question",
	"idea",
	"contract_change",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

/** Where triage sends an item; each names the one `routed_*` column (or `answer`, `duplicate_of`) it sets. */
export const FEEDBACK_ROUTES = [
	"issue",
	"revision",
	"new_requirement",
	"answer",
	"duplicate",
] as const;
export type FeedbackRoute = (typeof FEEDBACK_ROUTES)[number];

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
	bug: "Bug",
	change_request: "Change request",
	question: "Question",
	idea: "Idea",
	contract_change: "Contract change",
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
