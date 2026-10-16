/**
 * The project's storefront target over REST, so a shop skill knows WHICH store to build against.
 * The forge CLI calls it; core's MCP server carries no delivery tool.
 *
 * Every storefront provider is served (epodsystem, autoflow) and the answer carries `provider`; a
 * project binding storefronts of more than one provider must pass `provider`. `label` selects a
 * named storefront, else the oldest binding, and `stores[]` lists every active one.
 *
 * Provider facts are resolved LIVE on every read. `themesResolvedLive: false` (epodsystem) or
 * `backendResolvedLive: false` (autoflow) means the live read failed, so the dependent fields are
 * UNKNOWN rather than absent. `configured: true` only says an active binding with a usable credential
 * exists; `mcpInjection` ({ willInject, reason, serverName }) is whether a run actually gets the
 * provider's MCP tools, and `not_granted` there is a switch nobody turned on, not an auth fault.
 *
 * NEVER returns a credential: a run reaches the provider through Forge's relay (/api/mcp-relay).
 *
 * Registered ONTO `integrationsRoutes` for the reason coolify-routes.ts gives.
 */

import type { StorefrontRefusalCode } from '@forge/contracts/storefront';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  type IntegrationDeclaration,
  listActiveBindingsForProjectProvider,
  listIntegrations,
} from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { buildMcpPreview } from './mcp-preview-service.js';

const refuse = refuser<StorefrontRefusalCode>('STOREFRONT_REFUSED');

const querySchema = z
  .object({
    /** ISS-558 — optional label to select a named storefront. Omit (or '') for
     *  the default (oldest/unlabeled) binding. */
    label: z.string().optional(),
    /** ISS-51 — which storefront provider; needed only where a project binds more than one. */
    provider: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof querySchema>;

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

export function registerStorefrontRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  routes.get(
    '/:projectId/integrations/storefront/target',
    zValidator('query', querySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(projectId));
      return c.json(await storefrontTarget(projectId, c.req.valid('query')));
    },
  );
}

async function storefrontTarget(projectId: string, input: Input): Promise<unknown> {
  const served = storefrontProviders();
  let providers = served;
  if (input.provider !== undefined) {
    providers = served.filter((d) => d.provider === input.provider);
    if (providers.length === 0) {
      throw refuse(
        'STOREFRONT_PROVIDER_UNKNOWN',
        `"${input.provider}" is not a storefront provider; provider is one of ${served.map((d) => d.provider).join(', ')}.`,
        '/provider',
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
    throw refuse(
      'STOREFRONT_PROVIDER_AMBIGUOUS',
      `this project binds storefronts of ${bound.map((b) => b.decl.provider).join(' and ')}; pass provider (one of ${bound.map((b) => b.decl.provider).join(', ')}) to say which.`,
      '/provider',
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
    // A label no binding carries is the caller's mistake, never "no storefront configured".
    throw refuse(
      'STOREFRONT_LABEL_UNKNOWN',
      `no ${decl.provider} storefront is labelled "${requestedLabel}"; the labels are ${pairs.map((p) => `"${labelOf(p)}"`).join(', ')} ("" is the default).`,
      '/label',
    );
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
}
