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
	"suggestion_list",
	"mockup_list",
	"mockup_get",
] as const;
const DESIGN_TOOL_WRITES = [
	"design_create",
	"design_revise",
	"design_propose",
	"design_decide",
	"suggestion_create",
	"suggestion_accept",
	"suggestion_reject",
	"suggestion_revise",
	"suggestion_withdraw",
	"mockup_propose",
	"mockup_accept",
	"mockup_return",
	"mockup_withdraw",
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

/**
 * `create` writes nothing: an MCP client files no issue, and the action answers how one comes to
 * be (MCP_FILES_FEEDBACK_NOT_ISSUES), so it is read-class and reaches a read-only token too.
 */
export const ISSUES_TOOL_READS = ["list", "get", "create"] as const;
export const ISSUES_TOOL_ACTIONS = ISSUES_TOOL_READS;
