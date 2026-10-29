// The one MCP registry: every tool this server serves, keyed by the name contracts declares for it
// (`@forge/contracts/mcp-tools`). Each tool lives in its module's `tool.ts`. The REST API is the
// primary door and the forge CLI sits on it. Delivery — deploys, the source host, Sentry, the storefront target — is the CLI's over
// REST and has no tool here; this server is for the product layer.

import type { McpToolName } from '@forge/contracts/mcp-tools';
import { forgeChannelTool, forgeEcosystemTool } from '../ecosystem/tool.js';
import { forgeFeedbackTool } from '../forge-door/index.js';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import {
  forgeDesignTool,
  forgeIssuesTool,
  forgeQuestionsTool,
  forgeReleasesProductTool,
} from '../product-door/tool.js';
import { forgeBindingsTool, forgeConfigTool } from '../project-config/tool.js';
import { forgeProjectsTool } from '../projects/tool.js';
import { forgeSupportTool } from '../support/tool.js';
import { forgeUploadsTool } from '../uploads/tool.js';
import { projectFeedbackMcpTool } from './feedback-tool.js';
import { forgeRequirementsMcpTool } from './requirements-tool.js';

// Each entry defers to its factory, so reading this table never touches a module still loading.
export const MCP_TOOLS = {
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
  project_feedback: (ctx) => projectFeedbackMcpTool(ctx),
  // Feedback about Forge itself (REQ-47), from any project, filed as the caller into Forge's home.
  forge_feedback: (ctx) => forgeFeedbackTool(ctx),
  // The product layer, so a person works from an MCP client: each action calls what its REST route
  // calls, and every answer about work in motion says whether it runs and when it is likely done.
  forge_releases: (ctx) => forgeReleasesProductTool(ctx),
  forge_design: (ctx) => forgeDesignTool(ctx),
  forge_questions: (ctx) => forgeQuestionsTool(ctx),
  forge_issues: (ctx) => forgeIssuesTool(ctx),
  // A Rocket.Chat support group's session answers its group through this tool alone (REQ-75); only
  // that session, under its current turn's token, is admitted.
  forge_support: (ctx) => forgeSupportTool(ctx),
  // A project, its document and its bindings (ISS-767), so an MCP client finds the project it works
  // in and sets one up, over the services the REST doors call.
  forge_projects: (ctx) => forgeProjectsTool(ctx),
  forge_config: (ctx) => forgeConfigTool(ctx),
  forge_bindings: (ctx) => forgeBindingsTool(ctx),
} satisfies Record<McpToolName, ContextScopedMcpToolFactory>;
