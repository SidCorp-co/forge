import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

/**
 * Single read-chokepoint for the active device of a project.
 *
 * Sourced from `projects.agent_config.activeDeviceId` as a forward-compatible
 * home until the devices module ships a first-class column or join table.
 * Consumers must not read `agentConfig` directly — route through this helper.
 */
export async function getActiveDeviceId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const cfg = row.agentConfig as { activeDeviceId?: unknown } | null;
  const id = cfg?.activeDeviceId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
