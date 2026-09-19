/**
 * Which project an MCP call is about, and which projects its credential may
 * speak for. Split out of `lib.ts` — see the header on `project-authz.ts`.
 */

import type { McpPrincipal } from '../../middleware/require-pat.js';
import { findProjectIdBySlug } from '../../projects/service.js';

export function patEffectiveProjectIds(principal: McpPrincipal): readonly string[] | null {
  if (principal.kind !== 'pat') return null;
  if (principal.boundProjectId) return [principal.boundProjectId];
  return principal.projectIds;
}

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
