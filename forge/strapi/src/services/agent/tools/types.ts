/**
 * Agent tool type definitions and configuration.
 */

import type { ToolDefinition } from '../provider';

export interface AgentConfig {
  statuses?: string[];
  priorities?: string[];
  categories?: string[];
  relationTypes?: string[];
  enabledTools?: string[];
  enabledSkills?: string[];
  agentName?: string;
  agentRole?: string;
  behaviorRules?: string[];
  queryStrategies?: Record<string, string>;
  intentExamples?: string[];
  domainTemplate?: string;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  statuses: ['open', 'confirmed', 'waiting', 'approved', 'in_progress', 'deploying', 'testing', 'staging', 'released', 'closed', 'reopen', 'on_hold', 'needs_info'],
  priorities: ['critical', 'high', 'medium', 'low', 'none'],
  categories: ['bug', 'feature', 'improvement', 'task', 'epic'],
  relationTypes: ['related_to', 'caused_by', 'blocked_by', 'duplicate_of', 'fixed_by', 'depends_on'],
  enabledTools: ['forge_issues', 'forge_comments', 'forge_skills', 'forge_memory', 'forge_language', 'forge_config', 'forge_coolify_deploy', 'forge_sentry', 'forge_cloudflare', 'forge_projects', 'forge_health', 'forge_pipeline', 'forge_activity'],
};

export interface ForgeToolContext {
  strapi: any;
  projectDocumentId: string;
  signal: AbortSignal;
  userKey?: string;
  sentryProject?: string;
  agentConfig?: AgentConfig;
  hrmBaseUrl?: string;
  strapiJwt?: string;
  auditEnabled?: boolean;
  appId?: string;
  hubToken?: string;
  crossProjectAccess?: boolean;
  /** Pipeline skill name (e.g. 'forge-code') for role-scoped memory filtering */
  pipelineSkill?: string;
}

export interface ForgeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ForgeToolContext): Promise<string>;
}

export function toolToDefinition(tool: ForgeTool): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Resolve a target project by slug for cross-project access. Returns documentId and crossProjectAccess flag, or null. */
export async function resolveTargetProject(strapi: any, slug: string): Promise<{ documentId: string; crossProjectAccess: boolean } | null> {
  const project = await strapi.documents('api::project.project').findFirst({
    filters: { slug: { $eq: slug } },
    fields: ['documentId', 'crossProjectAccess'],
  });
  if (!project?.documentId) return null;
  return { documentId: project.documentId, crossProjectAccess: !!project.crossProjectAccess };
}
