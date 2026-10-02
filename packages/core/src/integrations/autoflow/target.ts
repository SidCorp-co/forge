/**
 * Autoflow's half of `forge_storefront_target`: the site a binding builds and the Backend Builder
 * graph behind it — workflows and the routes they answer — read live through the binding's token.
 */

import type { StorefrontTargetArgs } from '../types.js';
import { autoflowGql } from './client.js';
import {
  autoflowBaseUrl,
  autoflowGraphqlUrl,
  autoflowMcpUrl,
  autoflowSiteUrl,
} from './endpoints.js';
import { AUTOFLOW_REFRESH_MARGIN_MS, ensureFreshAutoflowToken } from './refresh.js';
import type { AutoflowConfig, AutoflowSecrets } from './types.js';

const LIVE_READ_TIMEOUT_MS = 5_000;

/**
 * The shop MCP tools a HOP-shaped build reaches for, grouped as the server registers them
 * (`backend-go/internal/mcp/tools/registry_test.go:TestRegistryParity`). Listed so an agent knows
 * the draft/publish/revert verbs by name before it lists the server's tools itself.
 */
export const AUTOFLOW_SHOP_TOOLS = {
  context: ['get_context', 'list_skills', 'get_skill'],
  backendBuild: [
    'get_backend_node_catalog',
    'list_backend_workflows',
    'save_backend_workflow',
    'validate_backend_workflow',
    'test_backend_workflow',
    'list_backend_tables',
    'create_backend_table',
    'list_backend_routes',
    'upsert_backend_route',
  ],
  backendRelease: [
    'publish_backend_workflow',
    'list_backend_workflow_versions',
    'revert_backend_workflow',
    'list_backend_runs',
    'get_backend_run_steps',
  ],
  site: [
    'customize_theme',
    'create_theme_preview',
    'publish_draft_theme',
    'snapshot_theme',
    'restore_theme_version',
    'create_page',
    'publish_page',
  ],
} as const;

const BACKEND_QUERY =
  'query ForgeAutoflowBackend { backendWorkflows { code name version published_at } backendRoutes { method path workflow_code is_published } }';

interface BackendWorkflowRow {
  code?: string;
  name?: string;
  version?: number | null;
  published_at?: string | null;
}

interface BackendRouteRow {
  method?: string;
  path?: string;
  workflow_code?: string;
  is_published?: boolean;
}

type LiveBackend =
  | { resolvedLive: true; workflows: BackendWorkflowRow[]; routes: BackendRouteRow[] }
  | { resolvedLive: false; reason: string };

async function readBackend(
  args: StorefrontTargetArgs,
  config: AutoflowConfig,
): Promise<LiveBackend> {
  let stored: Partial<AutoflowSecrets>;
  try {
    stored = args.readSecrets() as Partial<AutoflowSecrets>;
  } catch (err) {
    return { resolvedLive: false, reason: `secrets_unreadable: ${(err as Error).message}` };
  }
  if (!stored.accessToken) return { resolvedLive: false, reason: 'no_credential' };
  try {
    const fresh = await ensureFreshAutoflowToken({
      connectionId: args.connectionId,
      config,
      minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
    });
    if (fresh.kind === 'needs_reauth') return { resolvedLive: false, reason: fresh.reason };
    const token = fresh.secrets?.accessToken ?? stored.accessToken;
    const url = autoflowGraphqlUrl(config);
    let res = await autoflowGql(url, token, BACKEND_QUERY, LIVE_READ_TIMEOUT_MS);
    if (res.kind === 'unauthorized') {
      const retry = await ensureFreshAutoflowToken({
        connectionId: args.connectionId,
        config,
        minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
        refusedToken: token,
      });
      if (retry.kind === 'needs_reauth') return { resolvedLive: false, reason: retry.reason };
      if (retry.kind === 'ok' && retry.secrets.accessToken !== token) {
        res = await autoflowGql(
          url,
          retry.secrets.accessToken,
          BACKEND_QUERY,
          LIVE_READ_TIMEOUT_MS,
        );
      }
    }
    if (res.kind === 'ok') {
      return {
        resolvedLive: true,
        workflows: (res.data.backendWorkflows as BackendWorkflowRow[] | null) ?? [],
        routes: (res.data.backendRoutes as BackendRouteRow[] | null) ?? [],
      };
    }
    if (res.kind === 'unauthorized')
      return { resolvedLive: false, reason: `unauthorized: ${res.message}` };
    if (res.kind === 'http-error') return { resolvedLive: false, reason: `http_${res.status}` };
    return { resolvedLive: false, reason: `graphql_error: ${res.message}` };
  } catch (err) {
    return { resolvedLive: false, reason: `unreachable: ${(err as Error).message}` };
  }
}

export async function autoflowStorefrontTarget(
  args: StorefrontTargetArgs,
): Promise<Record<string, unknown>> {
  const config = args.config as AutoflowConfig;
  const shop = config.shop ?? null;
  const live = await readBackend(args, config);
  return {
    shop,
    orgId: config.orgId ?? null,
    storeId: config.storeId ?? null,
    storeSlug: config.storeSlug ?? null,
    storeName: config.storeName ?? null,
    themeId: config.themeId ?? null,
    commerceEnabled: config.commerceEnabled ?? null,
    siteUrl: shop ? autoflowSiteUrl(config, shop) : null,
    endpoint: autoflowBaseUrl(config),
    mcpUrl: autoflowMcpUrl(config),
    backendResolvedLive: live.resolvedLive,
    ...(live.resolvedLive
      ? {
          workflows: live.workflows.map((w) => ({
            code: w.code ?? null,
            name: w.name ?? null,
            version: w.version ?? null,
            publishedAt: w.published_at ?? null,
          })),
          routes: live.routes.map((r) => ({
            method: r.method ?? null,
            path: r.path ?? null,
            workflow: r.workflow_code ?? null,
            published: r.is_published ?? null,
          })),
        }
      : {
          workflows: null,
          routes: null,
          backendUnresolvedBecause: live.reason,
          note: 'The live Backend Builder read failed, so workflows[] and routes[] are UNKNOWN, not empty: this answer carries the binding facts only. Read them through the shop MCP (`list_backend_workflows`, `list_backend_routes`) or report the reason.',
        }),
    shopTools: AUTOFLOW_SHOP_TOOLS,
  };
}
