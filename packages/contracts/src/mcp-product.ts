// The product tools core's MCP server serves a person working from an MCP client: each tool's
// actions, split into the reads and the writes, so the tool's schema, its per-action grant and the
// transport's read/write class are read off one list.

export const RELEASES_TOOL_READS = ["list", "get", "page"] as const;
const RELEASES_TOOL_WRITES = ["name", "decide"] as const;
export const RELEASES_TOOL_ACTIONS = [
	...RELEASES_TOOL_READS,
	...RELEASES_TOOL_WRITES,
] as const;

export const DESIGN_TOOL_READS = [
	"design_list",
	"design_get",
	"template_list",
	"suggestion_list",
	"mockup_list",
	"mockup_get",
	"mockup_comments",
] as const;
const DESIGN_TOOL_WRITES = [
	"design_create",
	"design_revise",
	"design_propose",
	"design_decide",
	"design_withdraw",
	"suggestion_create",
	"suggestion_accept",
	"suggestion_reject",
	"suggestion_revise",
	"suggestion_withdraw",
	"mockup_propose",
	"mockup_accept",
	"mockup_return",
	"mockup_withdraw",
	"mockup_comment",
] as const;
export const DESIGN_TOOL_ACTIONS = [
	...DESIGN_TOOL_READS,
	...DESIGN_TOOL_WRITES,
] as const;

export const QUESTIONS_TOOL_READS = ["list", "get"] as const;
const QUESTIONS_TOOL_WRITES = ["answer", "ask"] as const;
export const QUESTIONS_TOOL_ACTIONS = [
	...QUESTIONS_TOOL_READS,
	...QUESTIONS_TOOL_WRITES,
] as const;

/** `create` files an issue by the same create every other door takes, so it is write-class (ISS-861). */
export const ISSUES_TOOL_READS = ["list", "get"] as const;
const ISSUES_TOOL_WRITES = ["create"] as const;
export const ISSUES_TOOL_ACTIONS = [
	...ISSUES_TOOL_READS,
	...ISSUES_TOOL_WRITES,
] as const;

/**
 * A persistent project thread with the Forge bot (REQ-91): `open` opens or resumes one, `send` says
 * something in it, and `cancel` ends the turn it runs, so all three are write-class; `threads` and
 * `read` only read, a read waiting for a reply included.
 */
export const BOT_TOOL_READS = ["threads", "read"] as const;
const BOT_TOOL_WRITES = ["open", "send", "cancel"] as const;
export const BOT_TOOL_ACTIONS = [
	...BOT_TOOL_READS,
	...BOT_TOOL_WRITES,
] as const;

/**
 * How a project stands, what waits on the caller and the decisions recorded (ISS-1183, REQ-78 BC-8):
 * the `project.*` door runs the assistant's own reads, so a product role on MCP and the chat beside
 * it cannot disagree. All three only read.
 */
export const PROJECT_TOOL_READS = ["status", "needs_you", "decisions"] as const;

/**
 * Where an issue comes from, said once for every text the MCP door serves on filing one (its
 * `issues.create` guide and the server's instructions), so they cannot drift apart or from the org
 * guide `mcp-issue-creation-is-guided` (owner rulings 2026-10-16, 2026-11-01, 2026-11-07): the caller
 * chooses the lane and records why, and asks a person only for product direction (ISS-1183).
 */
export const ISSUE_FILING_LANE =
	"An issue is the delivery side, so start from the product: a problem or idea a person reports goes to Feedback (project_feedback.submit), and new or changed behaviour to a Requirement (requirements.create, or requirements.revise for one that exists); their triage and delivery file the issues. File one directly for delivery work an agreed requirement or a triaged feedback item already covers, or for a technical finding of your own (a defect against an existing expectation, security, performance, debt). Choose the lane yourself and say why in what you file; a person is asked only for product direction, never before filing.";
