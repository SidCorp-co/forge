// cm:why one declaration of the agent-report vocabulary (ISS-93): core's table, REST, MCP and the web
// import the values, the refusal codes and the row shape from here. An agent report is what an
// agent says about the harness it ran under; a person's report on the product is feedback (FB-n).

import { z } from "zod";
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
// cm:why design automation rev 1 (steps triage, file, dismiss; ISS-113): what a person decided a
// report is, with who and when. `filed` has exactly one target, an issue or the feedback item a
// promote made, so where a report went is the target and never a fifth state
export const AGENT_REPORT_TRIAGES = [
	"new",
	"filed",
	"dismissed",
	"duplicate",
] as const;
export type AgentReportTriage = (typeof AGENT_REPORT_TRIAGES)[number];

export const AGENT_REPORT_TRIAGE_ACTS = [
	"file",
	"dismiss",
	"duplicate",
	"reopen",
] as const;
export type AgentReportTriageAct = (typeof AGENT_REPORT_TRIAGE_ACTS)[number];
export const AGENT_REPORT_LIMITS = {
	reason: 2000,
	title: 200,
	description: 20000,
} as const;

export const AGENT_REPORT_REFUSAL_CODES = [
	"AGENT_REPORT_PROMOTED",
	"AGENT_REPORT_ALREADY_TRIAGED",
	"AGENT_REPORT_DISMISS_REASON_REQUIRED",
	"AGENT_REPORT_DUPLICATE_UNKNOWN",
	"AGENT_REPORT_NOT_TRIAGED",
	"AGENT_REPORT_FILED_INTO_ISSUE",
	"AGENT_REPORT_BULK_PROJECT_REQUIRED",
	"AGENT_REPORT_BULK_CREATE_ACROSS_PROJECTS",
	"AGENT_REPORT_NO_WRITABLE_PROJECT",
] as const;
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
	scheduleRunId: string | null;
	triage: AgentReportTriage;
	triagedBy: { id: string; name: string | null } | null;
	triagedAt: string | null;
	triageReason: string | null;
	duplicateOf: string | null;
	linkedIssueId: string | null;
	feedback: AgentReportFeedbackLink | null;
	createdAt: string;
}

const reason = z.string().max(AGENT_REPORT_LIMITS.reason);

/** One triage act. A dismiss without a reason is a refusal (AGENT_REPORT_DISMISS_REASON_REQUIRED), not a bad body. */
export const triageAgentReportRequestSchema = z
	.discriminatedUnion("act", [
		z.strictObject({
			act: z.literal("file"),
			issue: z.uuid().optional(),
			createIssue: z
				.strictObject({
					title: z.string().min(1).max(AGENT_REPORT_LIMITS.title).optional(),
					description: z
						.string()
						.max(AGENT_REPORT_LIMITS.description)
						.optional(),
				})
				.optional(),
		}),
		z.strictObject({ act: z.literal("dismiss"), reason: reason.optional() }),
		z.strictObject({
			act: z.literal("duplicate"),
			duplicateOf: z.uuid(),
			reason: reason.optional(),
		}),
		z.strictObject({ act: z.literal("reopen"), reason: reason.optional() }),
	])
	.refine(
		(t) =>
			t.act !== "file" ||
			(t.issue === undefined) !== (t.createIssue === undefined),
		{
			message: "file names exactly one of issue or createIssue",
			path: ["issue"],
		},
	);
export type TriageAgentReportRequest = z.infer<
	typeof triageAgentReportRequestSchema
>;
export const TRIAGE_AGENT_REPORT_SHAPE =
	"{ act: file, exactly one of issue: uuid | createIssue: { title?, description? } } | { act: dismiss, reason } | { act: duplicate, duplicateOf: uuid, reason? } | { act: reopen, reason? }";

/** The bulk door: every report of one signal, in one project or every project the caller sees. */
export const triageAgentReportsBySignalRequestSchema = z.strictObject({
	signalKey: z.string().min(1).max(500),
	projectId: z.uuid().optional(),
	scope: z.enum(["project", "all"]).optional(),
	triage: triageAgentReportRequestSchema,
});
export const TRIAGE_AGENT_REPORTS_BY_SIGNAL_SHAPE = `{ signalKey, projectId? (required unless scope: all), scope?: project | all, triage: ${TRIAGE_AGENT_REPORT_SHAPE} }`;

/** What a triage wrote: the reports it moved, to which triage, and the issue a file created or linked. */
export interface AgentReportTriageEffect {
	act: AgentReportTriageAct;
	triage: AgentReportTriage;
	reports: string[];
	issue: { id: string; key: string; created: boolean } | null;
	untouched: { id: string; triage: AgentReportTriage }[];
}
