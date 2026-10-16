// The one MCP registry: every tool this server serves, keyed by the name contracts declares for it
// (`@forge/contracts/mcp-tools`). Each tool lives in its module's `tool.ts`. The REST API is the
// primary door and the forge CLI sits on it. Delivery — deploys, the source host, Sentry, the storefront target — is the CLI's over
// REST and has no tool here; this server is for the product layer.

import type { McpToolName } from '@forge/contracts/mcp-tools';
import { forgeAgentReportTool } from '../agent-reports/tool.js';
import { forgeChannelTool, forgeEcosystemTool } from '../ecosystem/tool.js';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import { forgeUploadsTool } from '../uploads/tool.js';
import { forgeFeedbackMcpTool } from './feedback-tool.js';
import { forgeRequirementsMcpTool } from './requirements-tool.js';

// Each entry defers to its factory, so reading this table never touches a module still loading.
export const MCP_TOOLS = {
  // Every action has a REST twin under /api/agent-reports (POST /, GET /, POST /:id/triage, and
  // POST /triage by signalKey), and get's is GET /api/projects/:id/automation/reports/:reportId.
  // Kept for forge-plugin clients, which still call it: the priced amnesty
  // `mcp-tools-with-rest-twins` in .forge/conformance.json names the condition that deletes it.
  forge_agent_report: (ctx) => forgeAgentReportTool(ctx),
  // An image attachment comes back as a viewable block; `forge-runner api` prints text only.
  forge_uploads: (ctx) => forgeUploadsTool(ctx),
  // Every action has a REST twin under
  // /api/projects/:id/channel|interface|links|builder-runs|contracts|contract-context and
  // /api/ecosystems, and every prompt in this repo names the route; kept for forge-plugin clients,
  // whose CLI has no REST verbs for them, under the same amnesty `mcp-tools-with-rest-twins`.
  forge_channel: (ctx) => forgeChannelTool(ctx),
  forge_ecosystem: (ctx) => forgeEcosystemTool(ctx),
  // The product layer (owner, 2026-10-16): a BA works requirements and feedback from an MCP client,
  // each answer telling whether work runs and when it is forecast done.
  forge_requirements: (ctx) => forgeRequirementsMcpTool(ctx),
  forge_feedback: (ctx) => forgeFeedbackMcpTool(ctx),
} satisfies Record<McpToolName, ContextScopedMcpToolFactory>;
