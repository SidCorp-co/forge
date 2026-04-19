/**
 * Agent tools — type definitions, tool implementations, and registry.
 */

export {
  type AgentConfig,
  DEFAULT_AGENT_CONFIG,
  type ForgeToolContext,
  type ForgeTool,
  resolveTargetProject,
} from './types';

export {
  forgeTools,
  getForgeTools,
  getToolDefinitions,
  getToolMap,
} from './registry';
