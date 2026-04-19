/**
 * Tool registry: collection, filtering, and config application.
 */

import type { ToolDefinition } from '../provider';
import { createHrmTools } from '../hrm';
import type { AgentConfig, ForgeTool } from './types';
import { toolToDefinition } from './types';
import {
  forgeIssues, forgeComments, forgeAgentSessions, forgeMemory,
  forgeLanguage, forgeCoolifyDeploy, forgeSentry, forgeCloudflare,
  forgeSkills, forgeConfig, forgeTodoWrite, forgeCodeRun,
  forgeClaude, forgeIntegrationGuide, forgeProjects, forgeHealth,
  forgePipeline, forgeActivity, forgeSchedule,
} from './definitions';

export const forgeTools: ForgeTool[] = [forgeIssues, forgeComments, forgeAgentSessions, forgeMemory, forgeLanguage, forgeCoolifyDeploy, forgeSentry, forgeCloudflare, forgeSkills, forgeConfig, forgeTodoWrite, forgeCodeRun, forgeClaude, forgeIntegrationGuide, forgeProjects, forgeHealth, forgePipeline, forgeActivity, forgeSchedule];

/**
 * Apply agentConfig enums to tool parameters.
 */
function applyConfigEnums(def: ToolDefinition, config: AgentConfig): ToolDefinition {
  if (def.name !== 'forge_issues') return def;

  const params = JSON.parse(JSON.stringify(def.parameters));
  const props = params.properties;

  if (props?.filters?.properties) {
    if (config.statuses) props.filters.properties.status = { type: 'string', enum: config.statuses };
    if (config.priorities) props.filters.properties.priority = { type: 'string', enum: config.priorities };
  }

  if (props?.data?.properties) {
    if (config.statuses) props.data.properties.status = { type: 'string', enum: config.statuses };
    if (config.priorities) props.data.properties.priority = { type: 'string', enum: config.priorities };
    if (config.relationTypes && props.data.properties.relations?.items?.properties?.type) {
      props.data.properties.relations.items.properties.type = { type: 'string', enum: config.relationTypes };
    }
  }

  return { ...def, parameters: params };
}

export function getForgeTools(appConfig?: any): ForgeTool[] {
  const base = [...forgeTools];
  if (appConfig?.hrmBaseUrl) {
    base.push(...createHrmTools());
  }
  return base;
}

export function getToolDefinitions(agentConfig?: AgentConfig, appConfig?: any): ToolDefinition[] {
  let tools = getForgeTools(appConfig);

  if (agentConfig?.enabledTools?.length) {
    const enabled = new Set(agentConfig.enabledTools);
    enabled.add('forge_config');
    enabled.add('TodoWrite');
    tools = tools.filter((t) => enabled.has(t.name));
  }

  let defs = tools.map(toolToDefinition);

  if (agentConfig) {
    defs = defs.map((d) => applyConfigEnums(d, agentConfig));
  }

  return defs;
}

export function getToolMap(agentConfig?: AgentConfig, appConfig?: any): Map<string, ForgeTool> {
  let tools = getForgeTools(appConfig);
  if (agentConfig?.enabledTools?.length) {
    const enabled = new Set(agentConfig.enabledTools);
    enabled.add('forge_config');
    enabled.add('TodoWrite');
    tools = tools.filter((t) => enabled.has(t.name));
  }
  return new Map(tools.map((t) => [t.name, t]));
}
