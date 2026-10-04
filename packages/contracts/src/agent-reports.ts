// cm:why one declaration of the agent-report vocabulary (ISS-93): core's table, REST, MCP and the web
// import the values, the refusal codes and the row shape from here. An agent report is what an
// agent says about the harness it ran under; a person's report on the product is feedback (FB-n).

import type { FeedbackPhase, FeedbackRoute } from "./feedback.js";

export const AGENT_REPORT_KINDS = [
	"friction",
	"bug",
	"skill_gap",
	"unclear_step",
	"redundant_step",
	"learning",
	"suggestion",
] as const;
export type AgentReportKind = (typeof AGENT_REPORT_KINDS)[number];

export const AGENT_REPORT_SEVERITIES = ["low", "medium", "high"] as const;
export type AgentReportSeverity = (typeof AGENT_REPORT_SEVERITIES)[number];

export const AGENT_REPORT_TARGETS = [
	"skill",
	"prompt",
	"tool",
	"doc",
	"orientation",
	"pipeline",
	"other",
] as const;
export type AgentReportTarget = (typeof AGENT_REPORT_TARGETS)[number];
export const AGENT_REPORT_REFUSAL_CODES = ["AGENT_REPORT_PROMOTED"] as const;
export type AgentReportRefusalCode =
	(typeof AGENT_REPORT_REFUSAL_CODES)[number];
export interface AgentReportFeedbackLink {
	id: string;
	key: string;
	phase: FeedbackPhase;
	route: { route: FeedbackRoute; key: string | null } | null;
}
export interface AgentReportView {
	id: string;
	projectId: string;
	projectSlug: string | null;
	issueId: string | null;
	runId: string | null;
	jobId: string | null;
	stage: string | null;
	kind: AgentReportKind;
	severity: AgentReportSeverity;
	target: AgentReportTarget;
	targetRef: string | null;
	summary: string;
	detail: string | null;
	suggestion: string | null;
	signalKey: string;
	sessionId: string | null;
	reviewedAt: string | null;
	linkedIssueId: string | null;
	feedback: AgentReportFeedbackLink | null;
	createdAt: string;
}
