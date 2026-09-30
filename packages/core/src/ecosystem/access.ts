import { HTTPException } from 'hono/http-exception';
import type { OrgMemberRole } from '../db/schema.js';
import { loadOrgRole, loadVisibleProjectIds, orgRoleAtLeast } from '../lib/authz.js';

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export async function stewardRole(
  stewardOrgId: string,
  userId: string | undefined,
): Promise<OrgMemberRole | null> {
  return loadOrgRole(stewardOrgId, userId);
}

export async function assertStewardAdmin(
  stewardOrgId: string,
  userId: string | undefined,
  act: string,
): Promise<void> {
  const role = await stewardRole(stewardOrgId, userId);
  if (!orgRoleAtLeast(role, 'admin')) {
    throw forbidden(`${act} is the steward's: it needs owner or admin of org ${stewardOrgId}`);
  }
}

export async function readerProjects(userId: string | undefined): Promise<Set<string>> {
  return new Set(await loadVisibleProjectIds(userId));
}
