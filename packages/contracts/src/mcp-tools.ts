/**
 * The tools the MCP door serves, by the name each is served under. The registry
 * (`packages/core/src/mcp/registry.ts`) maps every name to its tool and is typed against this
 * list, so a name with no tool, or a tool with no name, does not compile.
 */
export const MCP_TOOL_NAMES = [
	"forge_agent_report",
	"forge_uploads",
	"forge_channel",
	"forge_ecosystem",
	"forge_source",
	"forge_coolify_deploy",
	"forge_sentry",
	"forge_storefront_target",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
