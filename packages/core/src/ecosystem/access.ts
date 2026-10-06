import { db } from '../db/client.js';
import { loadOrgRole, loadVisibleProjectIds } from '../lib/authz.js';
import { RefusalError } from '../lib/refusal.js';
import { requireOrgHeld } from '../permissions/index.js';
import { activeMembersOf } from './membership-store.js';
import type { EcosystemRefusal } from './refusals.js';

export { forbidden, notFound } from '../middleware/route-errors.js';

export const refusedBy = (refusal: EcosystemRefusal) =>
  new RefusalError([refusal], 'ECOSYSTEM_REFUSED');

export async function assertStewardAdmin(
  stewardOrgId: string,
  userId: string | undefined,
): Promise<void> {
  requireOrgHeld(stewardOrgId, await loadOrgRole(stewardOrgId, userId), 'org.admin');
}

// a fence names the projects a credential acts for, so the reader is only those of the person's projects inside it
export async function readerProjects(
  userId: string | undefined,
  fence?: readonly string[],
): Promise<Set<string>> {
  const visible = new Set(await loadVisibleProjectIds(userId));
  return fence ? new Set(fence.filter((p) => visible.has(p))) : visible;
}

// an ecosystem-scoped chat reads as every member project the person holds a role in, home first; the fence never names a project the person cannot already read, so a counterparty's internals stay out
export async function ecosystemReadFence(
  userId: string,
  homeProjectId: string,
  ecosystemId: string,
): Promise<string[]> {
  const visible = await readerProjects(userId);
  const members = await activeMembersOf(db, ecosystemId);
  return [homeProjectId, ...members.filter((p) => p !== homeProjectId && visible.has(p))];
}
