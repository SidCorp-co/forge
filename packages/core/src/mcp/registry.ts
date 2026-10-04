// The one MCP registry: every tool this server serves, keyed by the name contracts declares for it
// (`@forge/contracts/mcp-tools`). Each tool lives in its module's `tool.ts`, and a provider's in
// the integration door as `<port>-tool.ts`, never in the adapter. The REST API is the primary door
// and the forge CLI sits on it; a tool is listed here only where an agent Forge runs needs it and
// neither covers it.

import type { McpToolName } from '@forge/contracts/mcp-tools';
import { forgeAgentReportTool } from '../agent-reports/index.js';
import { forgeChannelTool, forgeEcosystemTool } from '../ecosystem/index.js';
import {
  forgeCoolifyDeployTool,
  forgeGoogleSheetsTool,
  forgeSentryTool,
  forgeSourceTool,
  forgeStorefrontTargetTool,
} from '../integration-door/index.js';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import { forgeUploadsTool } from '../uploads/index.js';

// Each entry defers to its factory, so reading this table never touches a module still loading.
export const MCP_TOOLS = {
  // submit reads the caller's live job or session context, which no REST route resolves.
  forge_agent_report: (ctx) => forgeAgentReportTool(ctx),
  // An image attachment comes back as a viewable block; `forge-runner api` prints text only.
  forge_uploads: (ctx) => forgeUploadsTool(ctx),
  // The channel's unanswered read is device-only over REST and its gate answers across the
  // ecosystem fence; the ecosystem's contract context has no REST route.
  forge_channel: (ctx) => forgeChannelTool(ctx),
  forge_ecosystem: (ctx) => forgeEcosystemTool(ctx),
  // A core-mediated integration's agent path: the provider credential stays in core, and no REST
  // route serves these reads and writes (for Coolify, its deployment and runtime logs).
  forge_source: (ctx) => forgeSourceTool(ctx),
  forge_coolify_deploy: (ctx) => forgeCoolifyDeployTool(ctx),
  forge_sentry: (ctx) => forgeSentryTool(ctx),
  forge_google_sheets: (ctx) => forgeGoogleSheetsTool(ctx),
  forge_storefront_target: (ctx) => forgeStorefrontTargetTool(ctx),
} satisfies Record<McpToolName, ContextScopedMcpToolFactory>;
