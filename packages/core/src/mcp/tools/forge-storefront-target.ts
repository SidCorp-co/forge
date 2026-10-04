import { z } from 'zod';
import { buildMcpPreview } from '../../integrations/mcp-preview-service.js';
import { listIntegrations } from '../../integrations/registry.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../../integrations/store.js';
import type { IntegrationDeclaration } from '../../integrations/types.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    projectId: z.uuid().optional(),
    /** ISS-558 — optional label to select a named storefront. Omit (or '') for
     *  the default (oldest/unlabeled) binding. */
    label: z.string().optional(),
    /** ISS-51 — which storefront provider; needed only where a project binds more than one. */
    provider: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type Served = IntegrationDeclaration & {
  storefrontTarget: NonNullable<IntegrationDeclaration['storefrontTarget']>;
};

/** Every provider a project's `source.storefront` may name — the ones declaring the hook. */
function storefrontProviders(): Served[] {
  return listIntegrations().filter((d): d is Served => typeof d.storefrontTarget === 'function');
}

const labelOf = (p: BindingWithConnection): string =>
  ((p.binding as Record<string, unknown>).label as string) ?? '';

async function resolveInjectionStatus(
  projectId: string,
  bindingId: string,
): Promise<{ willInject: boolean; reason: string; serverName: string | null } | null> {
  try {
    const preview = await buildMcpPreview(projectId);
    const row = preview.servers.find((r) => r.bindingId === bindingId);
    if (!row) return null;
    return { willInject: row.willInject, reason: row.reason, serverName: row.serverName };
  } catch (err) {
    return {
      willInject: false,
      reason: `preview_unreadable: ${err instanceof Error ? err.message : String(err)}`,
      serverName: null,
    };
  }
}

export const forgeStorefrontTargetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_storefront_target',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    "Return the project's storefront target so a shop skill knows WHICH store to build against. " +
    'Serves every storefront provider (epodsystem, autoflow); the answer carries `provider`, and ' +
    'a project binding storefronts of more than one provider must pass `provider` ' +
    '(STOREFRONT_PROVIDER_AMBIGUOUS otherwise; an unknown one is STOREFRONT_PROVIDER_UNKNOWN). ' +
    'ISS-558: a project may have multiple storefronts — the ' +
    'optional `label` param selects a named one; omitting it returns the default (oldest) ' +
    'binding. The response includes a `stores[]` discovery array listing all active bindings. ' +
    'EPODSYSTEM returns { configured, provider, orgId, scopes, storeId, storeSlug, storeName, themeId, themeName, ' +
    'draftThemeId, themes[], versions[], themesResolvedLive, commerceEnabled, domain, endpoint, ' +
    'label, stores[] }. ' +
    'THEMES ARE RESOLVED LIVE on every call (not cached): `themeId` is the current live/`main` ' +
    'theme, `draftThemeId` is the reusable unpublished draft clone of that main (null = no draft ' +
    'exists yet, so `customize_theme` has not run), `themes[]` lists every theme with its role + ' +
    'parentThemeId, and `versions[]` lists recent snapshots of the main theme newest-first — those ' +
    'ids are what `restore_theme_version` rolls back to. ' +
    'CHECK `themesResolvedLive` FIRST: when it is false the live query failed, so draftThemeId / ' +
    'themes[] / versions[] are UNKNOWN rather than absent — do not read a null draftThemeId as ' +
    '"no draft" and do not fall back to the live theme; stop and report instead. ' +
    'ALWAYS pass an explicit theme_id to create_theme_preview — omitting it silently issues a ' +
    'token for the LIVE theme, which renders pre-change code and reads as a genuine failure. ' +
    '`domain` is the real primary published domain — use it for the live URL ' +
    '(https://<domain>/) and, with a preview token, for the DRAFT ' +
    'preview URL (https://<domain>/?preview_token=<token>). ' +
    'AUTOFLOW returns { configured, provider, label, stores[], shop, orgId, storeId, storeSlug, storeName, ' +
    'themeId, commerceEnabled, siteUrl, endpoint, mcpUrl, backendResolvedLive, workflows[], routes[], shopTools }: ' +
    '`workflows[]` (id, draftVersion, code, name, version, publishedAt — null = never published) and `routes[]` are the ' +
    'Backend Builder graph read live; `id` and `draftVersion` are what a storefront_draft verdict names (`POST /api/issues/:id/verdicts`). ' +
    'Backend Builder graph read live; when `backendResolvedLive` is false they are UNKNOWN, ' +
    '`backendUnresolvedBecause` says why, and the answer is the binding facts only. Writes land on a ' +
    'draft; `publish_backend_workflow` goes live and `revert_backend_workflow` rolls back. ' +
    'Returns { configured: false } when no active storefront integration exists. ' +
    '`configured: true` is NOT a promise that you have the provider MCP tools — it only means ' +
    'an active binding with a usable credential exists. `mcpInjection` is the real gate: ' +
    '{ willInject, reason, serverName }, where reason is ok | not_configured | disabled | ' +
    'no_credential | shadowed | not_granted | preview_unreadable: <why>. `not_granted` means nobody has turned on agent access ' +
    'for that binding: the integration is healthy and the switch is off, so do NOT read absent ' +
    'tools as an auth/reauth problem and do NOT retry. Report the reason and say where the switch ' +
    'is — beside the integration under Settings → Integrations, on the binding itself. ' +
    'NEVER returns ' +
    'a credential — the crmk_ key / sat_ token is injected into the runner only via its mcpServers ' +
    'entry. Build on the DRAFT; publishing promotes it. Project scope comes from ' +
    'the X-Forge-Project-Slug header (or an explicit projectId). Authorization: project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args) as Input;
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsMember(ctx.principal, projectId);

    const served = storefrontProviders();
    let providers = served;
    if (input.provider !== undefined) {
      providers = served.filter((d) => d.provider === input.provider);
      if (providers.length === 0) {
        throw new Error(
          `STOREFRONT_PROVIDER_UNKNOWN: "${input.provider}" is not a storefront provider; provider is one of ${served.map((d) => d.provider).join(', ')}.`,
        );
      }
    }

    const byProvider = await Promise.all(
      providers.map(async (decl) => ({
        decl,
        pairs: await listActiveBindingsForProjectProvider(projectId, decl.provider),
      })),
    );
    const bound = byProvider.filter((b) => b.pairs.length > 0);
    if (bound.length === 0) return { configured: false };

    // Build stores[] discovery array (all active bindings, every storefront provider).
    const stores = bound.flatMap(({ decl, pairs }) =>
      pairs.map((p) => {
        const cfg = effectiveConfig<Record<string, unknown>>(p);
        return {
          provider: decl.provider,
          label: labelOf(p),
          storeName: (cfg.storeName as string | undefined) ?? null,
          storeSlug:
            (cfg.storeSlug as string | undefined) ?? (cfg.shop as string | undefined) ?? null,
          configured: true,
        };
      }),
    );

    if (bound.length > 1) {
      throw new Error(
        `STOREFRONT_PROVIDER_AMBIGUOUS: this project binds storefronts of ${bound.map((b) => b.decl.provider).join(' and ')}; pass provider (one of ${bound.map((b) => b.decl.provider).join(', ')}) to say which.`,
      );
    }
    const [{ decl, pairs }] = bound as [(typeof bound)[number]];

    // Select the target binding: label specified → find that label;
    // no label (or '') → oldest (first returned by listActiveBindingsForProjectProvider).
    const requestedLabel = input.label ?? '';
    const pair = requestedLabel
      ? (pairs.find((p) => labelOf(p) === requestedLabel) ?? null)
      : pairs[0];

    if (!pair) {
      // Requested label not found — still return stores[] for discovery.
      return { configured: false, stores };
    }

    const target = await decl.storefrontTarget({
      connectionId: pair.connection.id,
      config: effectiveConfig<Record<string, unknown>>(pair),
      readSecrets: () => decryptConnectionSecrets(pair.connection),
    });
    const mcpInjection = await resolveInjectionStatus(projectId, pair.binding.id);

    return {
      configured: true,
      provider: decl.provider,
      label: labelOf(pair),
      stores,
      mcpInjection,
      ...target,
    };
  },
});
