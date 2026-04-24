import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Device } from '../../auth/deviceToken.js';
import { db } from '../../db/client.js';
import { projectMembers, projects } from '../../db/schema.js';
import type { McpTool } from './forge-version.js';

/**
 * Device-scoped MCP tool — receives the authenticated `Device` at build time
 * so the handler can enforce project membership.
 */
export type DeviceScopedMcpToolFactory = (device: Device) => McpTool;

/**
 * Convert a Zod schema to MCP JSON Schema. Zod v4 exposes this natively.
 */
export function zodToMcpSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Single DB lookup for both membership and owner-or-admin checks. Returns
 * `null` when the project does not exist; otherwise `isMember` implies the
 * device owner is an owner of the project OR in `projectMembers`, and
 * `isAdmin` implies that membership has role owner|admin.
 */
async function loadDeviceProjectRole(
  device: Device,
  projectId: string,
): Promise<{ isMember: boolean; isAdmin: boolean } | null> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  if (project.ownerId === device.ownerId) return { isMember: true, isAdmin: true };
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, device.ownerId)))
    .limit(1);
  if (!member) return { isMember: false, isAdmin: false };
  return {
    isMember: true,
    isAdmin: member.role === 'owner' || member.role === 'admin',
  };
}

/**
 * Throw if the device's owner is not a member (or owner) of the project.
 * Surfaced to the MCP caller as an `isError: true` tool result — see the
 * `server.ts` error path.
 */
export async function assertDeviceOwnerIsMember(device: Device, projectId: string): Promise<void> {
  const role = await loadDeviceProjectRole(device, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isMember) {
    throw new Error('FORBIDDEN: device owner is not a member of this project');
  }
}

/**
 * Throw if the device's owner is not owner/admin of the project. Used by
 * `forge_skills.register`.
 */
export async function assertDeviceOwnerIsAdmin(device: Device, projectId: string): Promise<void> {
  const role = await loadDeviceProjectRole(device, projectId);
  if (!role) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!role.isAdmin) {
    throw new Error('FORBIDDEN: requires owner or admin on the project');
  }
}
