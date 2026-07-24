import { z } from 'zod';
import { getGuide, listGuides } from '../../guides/registry.js';
import type { McpTool } from './forge-version.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'get']),
    slug: z.string().min(1).max(200).optional(),
  })
  .strict();

// Inlined instead of importing `zodToMcpSchema` from `./lib.js` — that module
// pulls in the DB client (env-validated at import time) for its
// membership-assertion helpers, which this tool has no use for: it is
// product-global with no project/DB dependency at all.
function schemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Product-global Forge capability guides (test credentials, dependencies,
 * memory, deploy safety, pipeline lifecycle, uploads…), fetched live from
 * the code-defined registry in `guides/registry.ts`. No `projectId`, no
 * project-membership check — this is not a project resource; `/mcp` is
 * already gated by `requirePatOrDevice()`. Same content as
 * `GET <host>/api/guides/<slug>.md`.
 */
export const forgeGuideTool: McpTool = {
  name: 'forge_guide',
  description:
    'Forge capability guides — product-global, fetched live, no projectId or membership required. ' +
    '`action=list` returns a body-free index (slug/title/summary/version). ' +
    '`action=get {slug}` returns the full markdown body; an unknown slug returns NOT_FOUND naming the valid slugs. ' +
    'Same content as `GET <host>/api/guides/<slug>.md`. Look one up before guessing how a Forge feature works.',
  inputSchema: schemaToJsonSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'list') {
      return { guides: listGuides() };
    }

    if (!input.slug) throw new Error('BAD_REQUEST: slug is required for action=get');
    const guide = getGuide(input.slug);
    if (!guide) {
      const validSlugs = listGuides()
        .map((g) => g.slug)
        .join(', ');
      throw new Error(`NOT_FOUND: unknown guide slug '${input.slug}'. Valid slugs: ${validSlugs}`);
    }
    return { guide };
  },
};
