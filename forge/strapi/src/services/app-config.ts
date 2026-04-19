import type { ForgeTool } from './agent/tools';

const UID = 'api::app-config.app-config' as const;

/**
 * Find an app config by appId, populate project.
 * Returns null if not found or disabled.
 */
export async function resolveAppConfig(strapi: any, appId: string): Promise<any | null> {
  const results = await strapi.documents(UID).findMany({
    filters: { appId: { $eq: appId } },
    populate: ['project'],
    limit: 1,
  });

  const config = results?.[0] ?? null;

  if (!config || config.enabled === false) {
    return null;
  }

  return config;
}

/**
 * Filter tools based on role config in app config.
 * If no role config found, returns all tools unchanged.
 */
export function filterToolsForApp(
  allTools: ForgeTool[],
  config: any,
  userRole?: string
): ForgeTool[] {
  const roleName = userRole || config.defaultRole;
  const roleConfig = config.roles?.[roleName];

  if (!roleConfig || !Array.isArray(roleConfig.tools)) {
    return allTools;
  }

  const allowedTools = new Set<string>(roleConfig.tools);
  return allTools.filter((tool) => allowedTools.has(tool.name));
}
