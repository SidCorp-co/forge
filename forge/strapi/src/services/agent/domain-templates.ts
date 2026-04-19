/**
 * Domain templates — loaded from database (domain-template content type).
 *
 * Templates are applied via `apply_template` which flattens all template
 * values into the project's agentConfig. Each project then owns its own
 * copy and can edit independently. The `domainTemplate` key is kept for
 * reference only (tracks which template was used as starting point).
 */

import type { AgentConfig } from './tools';

export interface DomainTemplate {
  documentId: string;
  key: string;
  label: string;
  description: string;
  isBuiltIn: boolean;
  config: Partial<AgentConfig>;
}

const UID = 'api::domain-template.domain-template' as any;

/**
 * List available templates from DB (for UI / config tool).
 */
export async function listDomainTemplates(
  strapi: any,
): Promise<{ key: string; label: string; description: string; isBuiltIn: boolean }[]> {
  const results = await strapi.documents(UID).findMany({
    fields: ['key', 'label', 'description', 'isBuiltIn'],
    sort: { key: 'asc' },
  });
  return (results || []).map((r: any) => ({
    key: r.key,
    label: r.label,
    description: r.description || '',
    isBuiltIn: r.isBuiltIn ?? true,
  }));
}

/**
 * Get full template from DB by key (for config tool apply_template).
 */
export async function getDomainTemplate(
  strapi: any,
  key: string,
): Promise<DomainTemplate | null> {
  const results = await strapi.documents(UID).findMany({
    filters: { key: { $eq: key } },
    limit: 1,
  });
  const tpl = results?.[0] as any;
  if (!tpl) return null;

  return {
    documentId: tpl.documentId,
    key: tpl.key,
    label: tpl.label,
    description: tpl.description || '',
    isBuiltIn: tpl.isBuiltIn ?? true,
    config: {
      agentName: tpl.agentName,
      agentRole: tpl.agentRole,
      statuses: tpl.statuses,
      priorities: tpl.priorities,
      categories: tpl.categories,
      behaviorRules: tpl.behaviorRules,
      queryStrategies: tpl.queryStrategies,
      enabledTools: tpl.enabledTools,
      intentExamples: tpl.intentExamples,
    },
  };
}
