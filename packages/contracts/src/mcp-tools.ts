import type { RefusalStatuses } from "./refusal.js";

/**
 * The tools the MCP door serves, by the name each is served under. The registry
 * (`packages/core/src/mcp/registry.ts`) maps every name to its tool and is typed against this
 * list, so a name with no tool, or a tool with no name, does not compile.
 */
export const MCP_TOOL_NAMES = [
	"forge_uploads",
	"forge_channel",
	"forge_ecosystem",
	"forge_requirements",
	"project_feedback",
	"forge_feedback",
	"forge_releases",
	"forge_design",
	"forge_questions",
	"forge_issues",
	"forge_support",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * The delivery tools the MCP door served until 2026-10-16, when the owner ruled delivery stays REST
 * and the CLI. A call to one is refused by name with the routes that replaced it, never answered
 * `Unknown tool` (catalog-fe's master, 2026-10-27, read that as the act being out of reach).
 */
export const MCP_RETIRED_DELIVERY_TOOLS = [
	"forge_source",
	"forge_coolify_deploy",
	"forge_sentry",
	"forge_storefront_target",
] as const;

export type McpRetiredDeliveryTool =
	(typeof MCP_RETIRED_DELIVERY_TOOLS)[number];

export const MCP_DOOR_REFUSAL_CODES = ["MCP_DELIVERY_IS_REST"] as const;
export type McpDoorRefusalCode = (typeof MCP_DOOR_REFUSAL_CODES)[number];

export const MCP_DOOR_REFUSAL_STATUSES = {
	MCP_DELIVERY_IS_REST: 404,
} as const satisfies RefusalStatuses<McpDoorRefusalCode>;
