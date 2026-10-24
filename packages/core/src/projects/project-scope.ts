import type { McpContext } from '../lib/tool.js';
import { argumentRefusal } from '../lib/tool-args.js';
import { findProjectIdBySlug } from './service.js';

const NO_PROJECT =
  'projectId is required: no X-Forge-Project-Slug header names the project and the token is bound to none';

export async function resolveProjectIdFromSlug(slug: string | null): Promise<string> {
  if (!slug) throw argumentRefusal('/projectId', NO_PROJECT);
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
  throw argumentRefusal('/projectId', NO_PROJECT);
}
