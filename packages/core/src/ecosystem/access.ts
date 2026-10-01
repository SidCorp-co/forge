import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import type { OrgMemberRole } from '../db/schema.js';
import { loadOrgRole, loadVisibleProjectIds, orgRoleAtLeast } from '../lib/authz.js';
import type { EcosystemRefusal } from './refusals.js';
import { activeMembersOf } from './store.js';

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const refusedBy = (refusal: EcosystemRefusal) =>
  new HTTPException(403, {
    message: refusal.detail,
    cause: { code: refusal.code, details: { refusals: [refusal] } },
  });

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

// cm:why an ecosystem-scoped chat reads as every member project the person holds a role in, home first; the fence never names a project the person cannot already read, so a counterparty's internals stay out
export async function ecosystemReadFence(
  userId: string,
  homeProjectId: string,
  ecosystemId: string,
): Promise<string[]> {
  const visible = await readerProjects(userId);
  const members = await activeMembersOf(db, ecosystemId);
  return [homeProjectId, ...members.filter((p) => p !== homeProjectId && visible.has(p))];
}
