/**
 * ISS-387 / ISS-558 — `forge_storefront_target` MCP tool.
 *
 * Exposes the project's Epodsystem STORE CONTEXT (slug + name + theme ids +
 * commerce flag + endpoint) to skills running on a runner, so a shop skill
 * knows which store/theme to build against. It deliberately returns NO API
 * key — the `crmk_` key reaches the runner only via the injected
 * `mcpServers.epodsystem` entry (see `integrations/epodsystem/resolver.ts`),
 * never through this read surface.
 *
 * ISS-558: supports multiple storefronts per project. The optional `label`
 * param selects a named binding ('' or omitted = default/oldest binding).
 * `stores[]` lists all active bindings for discovery.
 *
 * Returns `{ configured: false }` when the project has no active Epodsystem
 * integration. Authorization is membership-level, like `forge_postman_target`.
 */

import { z } from 'zod';
import { epodsystemEndpoint } from '../../integrations/epodsystem/endpoints.js';
import { fetchStorefrontThemes } from '../../integrations/epodsystem/themes.js';
import type { EpodsystemConfig, EpodsystemSecrets } from '../../integrations/epodsystem/types.js';
import { buildMcpPreview } from '../../integrations/mcp-preview-service.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../../integrations/store.js';
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
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

// cm:why best-effort: a slow or down Epodsystem must degrade this tool to "themes unknown", never fail it — a shop skill that cannot read its store context has nothing to fall back on
async function resolveLiveThemes(
  pair: Parameters<typeof effectiveConfig>[0],
  config: EpodsystemConfig,
): Promise<Awaited<ReturnType<typeof fetchStorefrontThemes>>> {
  if (!config.storeId) return null;
  try {
    const secrets = decryptConnectionSecrets<EpodsystemSecrets>(pair.connection);
    if (!secrets?.apiKey) return null;
    return await fetchStorefrontThemes(secrets.apiKey, config.storeId);
  } catch {
    return null;
  }
}

// cm:edge lockstep -> packages/core/src/integrations/mcp-preview-service.ts — the injection gate is computed THERE and only there; recomputing it here is what let `configured:true` drift into meaning "tools available" when it never did
async function resolveInjectionStatus(
  projectId: string,
  bindingId: string,
): Promise<{ willInject: boolean; reason: string; serverName: string | null } | null> {
  try {
    const preview = await buildMcpPreview(projectId);
    const row = preview.find((r) => r.bindingId === bindingId);
    if (!row) return null;
    return { willInject: row.willInject, reason: row.reason, serverName: row.serverName };
  } catch {
    return null;
  }
}

export const forgeStorefrontTargetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_storefront_target',
  description:
    "Return the project's Epodsystem storefront target so a shop skill knows WHICH store " +
    'and theme to build against. ISS-558: a project may have multiple storefronts — the ' +
    'optional `label` param selects a named one; omitting it returns the default (oldest) ' +
    'binding. The response includes a `stores[]` discovery array listing all active bindings. ' +
    'Returns { configured, orgId, scopes, storeId, storeSlug, storeName, themeId, themeName, ' +
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
    'Returns { configured: false } when no active epodsystem integration exists. ' +
    '`configured: true` is NOT a promise that you have `mcp__epodsystem__*` tools — it only means ' +
    'an active binding with a usable credential exists. `mcpInjection` is the real gate: ' +
    '{ willInject, reason, serverName }, where reason is ok | not_configured | disabled | ' +
    'no_credential | shadowed | not_declared. `not_declared` means no stage listed the sentinel in ' +
    "`pipelineConfig.mcpServers` — the integration is fine and the config is what's wrong, so do " +
    'NOT read absent tools as an auth/reauth problem or retry; report the reason. ' +
    'NEVER returns ' +
    'the API key — the crmk_ key is injected into the runner only via the mcpServers.epodsystem ' +
    'entry. Build on the DRAFT theme; publishing promotes draft → main. Project scope comes from ' +
    'the X-Forge-Project-Slug header (or an explicit projectId). Authorization: project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args) as Input;
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsMember(ctx.principal, projectId);

    const pairs = await listActiveBindingsForProjectProvider(projectId, 'epodsystem');
    if (pairs.length === 0) return { configured: false };

    // Build stores[] discovery array (all active bindings).
    const stores = pairs.map((p) => {
      const cfg = effectiveConfig<EpodsystemConfig>(p);
      const lbl = ((p.binding as Record<string, unknown>).label as string) ?? '';
      return {
        label: lbl,
        storeName: cfg.storeName ?? null,
        storeSlug: cfg.storeSlug ?? null,
        configured: true,
      };
    });

    // Select the target binding: label specified → find that label;
    // no label (or '') → oldest (first returned by listActiveBindingsForProjectProvider).
    const requestedLabel = input.label ?? '';
    const pair = requestedLabel
      ? (pairs.find(
          (p) =>
            (((p.binding as Record<string, unknown>).label as string) ?? '') === requestedLabel,
        ) ?? null)
      : pairs[0];

    if (!pair) {
      // Requested label not found — still return stores[] for discovery.
      return { configured: false, stores };
    }

    const config = effectiveConfig<EpodsystemConfig>(pair);
    const selectedLabel = ((pair.binding as Record<string, unknown>).label as string) ?? '';

    // cm:why themes are resolved LIVE, never from the stored config — a draft is created mid-run by customize_theme, so a cached draftThemeId is stale by construction (it was permanently null, which is what made every draft preview silently resolve to the live theme)
    const live = await resolveLiveThemes(pair, config);
    const mcpInjection = await resolveInjectionStatus(projectId, pair.binding.id);

    return {
      configured: true,
      label: selectedLabel,
      stores,
      orgId: config.orgId ?? null,
      scopes: config.scopes ?? null,
      storeId: config.storeId ?? null,
      storeSlug: config.storeSlug ?? null,
      storeName: config.storeName ?? null,
      themeId: live?.mainThemeId ?? config.themeId ?? null,
      themeName: config.themeName ?? null,
      draftThemeId: live?.draftThemeId ?? null,
      themes: live?.themes ?? null,
      versions: live?.versions ?? null,
      // cm:guard a caller MUST branch on this — `false` means themes/draftThemeId are unresolved, NOT that no draft exists, and treating unresolved as absent is how a step ends up building on the live theme
      themesResolvedLive: live !== null,
      mcpInjection,
      commerceEnabled: config.commerceEnabled ?? null,
      // Real primary published domain (best-effort resolved at healthcheck).
      // Live URL = https://<domain>/ ; draft preview = +?preview_token=<token>.
      domain: config.domain ?? null,
      // Fixed platform endpoint (EPODSYSTEM_ENDPOINT env), not per-store config.
      endpoint: epodsystemEndpoint(),
    };
  },
});
