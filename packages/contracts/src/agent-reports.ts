// The vocabulary of the retired agent reports (REQ-47 BC-8): what an agent said about the harness
// it ran under, before feedback about Forge had a door of its own. The rows stay, read-only, until
// they are carried into Forge feedback and a later migration drops the table; core's table CHECKs
// and the carry read these values, and nothing writes a new report.

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
// design automation rev 1 (steps triage, file, dismiss; ISS-113): what a person decided a
// report is, with who and when. `filed` has exactly one target, an issue or the feedback item a
// promote made, so where a report went is the target and never a fifth state
export const AGENT_REPORT_TRIAGES = [
	"new",
	"filed",
	"dismissed",
	"duplicate",
] as const;
export type AgentReportTriage = (typeof AGENT_REPORT_TRIAGES)[number];

export const AGENT_REPORT_REFUSAL_CODES = [
	"AGENT_REPORT_FILED_INTO_ISSUE",
] as const;
export type AgentReportRefusalCode =
	(typeof AGENT_REPORT_REFUSAL_CODES)[number];
