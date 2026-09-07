/**
 * Which project an MCP call is about, and which projects its credential may
 * speak for. Split out of `lib.ts` — see the header on `project-authz.ts`.
 */

import type { McpPrincipal } from '../../middleware/require-pat.js';
import { findProjectIdBySlug } from '../../projects/service.js';

/**
 * ISS-497 — the effective project allowlist for a principal. A project-level
 * PAT (`boundProjectId` set) is fenced to exactly its bound project, as if
 * `projectIds` contained only `[boundProjectId]`; binding and a multi-project
 * `projectIds` are mutually exclusive at mint. A user-level PAT keeps its
 * `projectIds` allowlist (NULL = inherit all the user's memberships). Device
 * principals have no PAT allowlist → `null` (unrestricted, gated by role).
 *
 * Folding the binding in here is what makes the cross-project conflict rule
 * (explicit arg/slug ≠ bound → NOT_FOUND) fall out of the existing fence
 * checks with no bespoke branch.
 */
export function patEffectiveProjectIds(principal: McpPrincipal): readonly string[] | null {
  if (principal.kind !== 'pat') return null;
  if (principal.boundProjectId) return [principal.boundProjectId];
  return principal.projectIds;
}

/**
 * Resolve a project slug (typically from `X-Forge-Project-Slug`) to its UUID.
 * Throws BAD_REQUEST when the slug is missing and NOT_FOUND when no project
 * matches. Tools that use slug-based scoping call this before
 * {@link assertDeviceOwnerIsMember}.
 */
export async function resolveProjectIdFromSlug(slug: string | null): Promise<string> {
  if (!slug) {
    throw new Error(
      'BAD_REQUEST: project context missing — set X-Forge-Project-Slug header or pass projectId',
    );
  }
  const id = await findProjectIdBySlug(slug);
  if (!id) throw new Error(`NOT_FOUND: project not found for slug "${slug}"`);
  return id;
}
