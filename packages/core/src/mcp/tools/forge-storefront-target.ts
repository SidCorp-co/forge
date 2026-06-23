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
import type { EpodsystemConfig } from '../../integrations/epodsystem/types.js';
import { effectiveConfig, listActiveBindingsForProjectProvider } from '../../integrations/store.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
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

export const forgeStorefrontTargetTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_storefront_target',
  description:
    "Return the project's Epodsystem storefront target so a shop skill knows WHICH store " +
    'and theme to build against. ISS-558: a project may have multiple storefronts — the ' +
    'optional `label` param selects a named one; omitting it returns the default (oldest) ' +
    'binding. The response includes a `stores[]` discovery array listing all active bindings. ' +
    'Returns { configured, orgId, scopes, storeId, storeSlug, storeName, themeId, ' +
    'themeName, draftThemeId, commerceEnabled, domain, endpoint, label, stores[] }. ' +
    '`domain` is the real primary published domain — use it for the live URL ' +
    '(https://<domain>/) and, with a preview token from create_theme_preview, for the DRAFT ' +
    'preview URL (https://<domain>/?preview_token=<token>). ' +
    'Returns { configured: false } when no active epodsystem integration exists. NEVER returns ' +
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
      const lbl = (p.binding as Record<string, unknown>).label as string ?? '';
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
      ? (pairs.find((p) => ((p.binding as Record<string, unknown>).label as string ?? '') === requestedLabel) ?? null)
      : pairs[0];

    if (!pair) {
      // Requested label not found — still return stores[] for discovery.
      return { configured: false, stores };
    }

    const config = effectiveConfig<EpodsystemConfig>(pair);
    const selectedLabel = (pair.binding as Record<string, unknown>).label as string ?? '';
    return {
      configured: true,
      label: selectedLabel,
      stores,
      orgId: config.orgId ?? null,
      scopes: config.scopes ?? null,
      storeId: config.storeId ?? null,
      storeSlug: config.storeSlug ?? null,
      storeName: config.storeName ?? null,
      themeId: config.themeId ?? null,
      themeName: config.themeName ?? null,
      draftThemeId: config.draftThemeId ?? null,
      commerceEnabled: config.commerceEnabled ?? null,
      // Real primary published domain (best-effort resolved at healthcheck).
      // Live URL = https://<domain>/ ; draft preview = +?preview_token=<token>.
      domain: config.domain ?? null,
      // Fixed platform endpoint (EPODSYSTEM_ENDPOINT env), not per-store config.
      endpoint: epodsystemEndpoint(),
    };
  },
});
