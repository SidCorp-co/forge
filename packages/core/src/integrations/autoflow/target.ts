/**
 * Autoflow's half of `forge_storefront_target`: the site a binding builds and the Backend Builder
 * graph behind it — workflows and the routes they answer — read live through the binding's token.
 */

import type { StorefrontTargetArgs } from '../index.js';
import { autoflowDraftVersion } from './draft.js';
import { autoflowBaseUrl, autoflowMcpUrl, autoflowSiteUrl } from './endpoints.js';
import { autoflowLiveRead } from './live-read.js';
import type { AutoflowConfig } from './types.js';

/**
 * The shop MCP tools a HOP-shaped build reaches for, grouped as the server registers them
 * (`backend-go/internal/mcp/tools/registry_test.go:TestRegistryParity`). Listed so an agent knows
 * the draft/publish/revert verbs by name before it lists the server's tools itself.
 */
const AUTOFLOW_SHOP_TOOLS = {
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
  'query ForgeAutoflowBackend { backendWorkflows { id code name version published_at draft } backendRoutes { method path workflow_code is_published } }';

interface BackendWorkflowRow {
  id?: string;
  draft?: unknown;
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
  const read = await autoflowLiveRead(args, config, BACKEND_QUERY);
  if (!read.ok) return { resolvedLive: false, reason: read.reason };
  return {
    resolvedLive: true,
    workflows: (read.data.backendWorkflows as BackendWorkflowRow[] | null) ?? [],
    routes: (read.data.backendRoutes as BackendRouteRow[] | null) ?? [],
  };
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
            id: w.id ?? null,
            draftVersion: autoflowDraftVersion(w.draft),
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
