import type { McpContext } from '../lib/tool.js';
import { findProjectIdBySlug } from './service.js';

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

/** The project a tool call is about: the one it names, else its slug header, else its bound project. */
export async function resolveEffectiveProjectId(
  ctx: McpContext,
  explicitProjectId?: string | null,
): Promise<string> {
  if (explicitProjectId) return explicitProjectId;
  if (ctx.projectSlug) return resolveProjectIdFromSlug(ctx.projectSlug);
  if (ctx.boundProjectId) return ctx.boundProjectId;
  throw new Error(
    'BAD_REQUEST: project context missing — set X-Forge-Project-Slug header or pass projectId',
  );
}
