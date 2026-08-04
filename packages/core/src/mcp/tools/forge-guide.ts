import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  deleteIntegrationGuide,
  integrationGuideSlug,
  providerFromGuideSlug,
  resolveGuide,
  resolveGuideIndex,
  upsertIntegrationGuide,
} from '../../guides/integration-guides.js';
import { INTEGRATION_PROVIDERS } from '../../integrations/types.js';
import { loadOrgRole, orgRoleAtLeast } from '../../lib/authz.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalUserId,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'upsert', 'delete']),
    slug: z.string().min(1).max(200).optional(),
    provider: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200).optional(),
    summary: z.string().min(1).max(500).optional(),
    body: z.string().min(1).max(200000).optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict();

// cm:edge contract -> packages/core/src/guides/registry.ts — the code tier owns Forge-capability slugs; this tool merges the per-org `integration-<provider>` tier on top, so a code guide must never claim that prefix
async function resolveOrgId(ctx: McpContext, projectIdArg?: string): Promise<string | null> {
  try {
    const projectId = await resolveEffectiveProjectId(ctx, projectIdArg);
    const [row] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return row?.orgId ?? null;
  } catch {
    // cm:why no project context is legitimate (a user-level PAT with no header) — the caller simply sees the code tier, exactly like the public REST surface
    return null;
  }
}

async function assertOrgAdmin(ctx: McpContext, orgId: string): Promise<string> {
  const userId = principalUserId(ctx.principal);
  const role = await loadOrgRole(orgId, userId);
  if (!orgRoleAtLeast(role, 'admin')) {
    throw new Error('FORBIDDEN: writing an integration guide requires org admin or owner');
  }
  return userId;
}

export const forgeGuideTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_guide',
  description:
    'Forge capability guides, fetched live. TWO TIERS, one slug space: (1) product-global guides about Forge features, defined in code, identical for every org; (2) per-ORG integration guides under the slug `integration-<provider>` (e.g. `integration-epodsystem`) documenting an external service — these are runtime-editable and shadow nothing else. ' +
    '`action=list` returns a body-free index (slug/title/summary/version) with your org overrides merged in. ' +
    '`action=get {slug}` returns the full markdown body; an unknown slug returns NOT_FOUND naming the valid slugs. ' +
    "`action=upsert {provider, title, summary, body}` creates/replaces YOUR ORG's guide for that integration (requires org admin/owner; `version` auto-increments so cached readers see the change). " +
    '`action=delete {provider}` drops the org override so the provider falls back to the code default, if it has one. ' +
    'Org is resolved from the project context (X-Forge-Project-Slug header, bound PAT, or an explicit projectId); with no project context you get the code tier only, same as `GET <host>/api/guides/<slug>.md`. ' +
    'Look one up before guessing how a Forge feature or a connected integration works.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'list') {
      return { guides: await resolveGuideIndex(await resolveOrgId(ctx, input.projectId)) };
    }

    if (input.action === 'get') {
      if (!input.slug) throw new Error('BAD_REQUEST: slug is required for action=get');
      const orgId = await resolveOrgId(ctx, input.projectId);
      const guide = await resolveGuide(input.slug, orgId);
      if (!guide) {
        const validSlugs = (await resolveGuideIndex(orgId)).map((g) => g.slug).join(', ');
        throw new Error(
          `NOT_FOUND: unknown guide slug '${input.slug}'. Valid slugs: ${validSlugs}`,
        );
      }
      return { guide };
    }

    const provider = input.provider ?? (input.slug ? providerFromGuideSlug(input.slug) : null);
    if (!provider) {
      throw new Error(
        `BAD_REQUEST: provider is required for action=${input.action} (or pass slug as integration-<provider>)`,
      );
    }
    if (!INTEGRATION_PROVIDERS.includes(provider as (typeof INTEGRATION_PROVIDERS)[number])) {
      throw new Error(
        `BAD_REQUEST: unknown integration provider '${provider}'. Known: ${INTEGRATION_PROVIDERS.join(', ')}`,
      );
    }

    const orgId = await resolveOrgId(ctx, input.projectId);
    if (!orgId) {
      throw new Error(
        'BAD_REQUEST: project context missing — an integration guide is per-org, so set X-Forge-Project-Slug or pass projectId',
      );
    }
    const userId = await assertOrgAdmin(ctx, orgId);

    if (input.action === 'delete') {
      const deleted = await deleteIntegrationGuide(orgId, provider);
      return { deleted, slug: integrationGuideSlug(provider), provider };
    }

    if (!input.title || !input.summary || !input.body) {
      throw new Error('BAD_REQUEST: title, summary and body are required for action=upsert');
    }
    const row = await upsertIntegrationGuide({
      orgId,
      provider: provider as Parameters<typeof upsertIntegrationGuide>[0]['provider'],
      title: input.title,
      summary: input.summary,
      body: input.body,
      updatedBy: userId,
    });
    return {
      guide: {
        slug: integrationGuideSlug(row.provider),
        title: row.title,
        summary: row.summary,
        version: row.version,
      },
    };
  },
});
