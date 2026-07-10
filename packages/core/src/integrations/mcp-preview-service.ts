/**
 * MCP injection preview (ISS-429) — service behind
 * `GET /:projectId/integrations/mcp-preview` (thin handler in routes.ts).
 *
 * ⚠️ DRIFT PAIR with `src/jobs/resolve-job-mcp-servers.ts` (and the
 * per-provider `apply*McpServers` resolvers it registers): this preview
 * MIRRORS dispatch-time semantics — same entry builders, same
 * active+credential filters, same oldest-first winning-binding pick
 * (`listActiveBindingsForProjectProvider`), same ISS-581/ISS-623 sentinel
 * opt-in gate — but it deliberately CANNOT call the dispatch resolvers:
 *   1. the resolvers decrypt the real vault credential into the entry; the
 *      preview must never mint secret bytes (placeholder key, redacted
 *      headers by construction);
 *   2. the resolvers return only the final winning map, while the preview
 *      reports one diagnostic row PER BINDING (disabled / no_credential /
 *      shadowed / not_declared);
 *   3. the resolvers gate on ONE dispatch's stage-resolved sentinel map; the
 *      preview checks the project-wide declared set (all stages).
 * When dispatch-time resolution changes (new provider, new gate, new pick
 * order), update BOTH files.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IntegrationEnvironment, projects } from '../db/schema.js';
import { collectDeclaredMcpNames } from '../pipeline/mcp-catalog.js';
import { buildEpodsystemMcpEntry } from './epodsystem/resolver.js';
import { buildPostmanMcpEntry } from './postman/resolver.js';
import { toIso } from './route-helpers.js';
import { buildSentryMcpEntry } from './sentry/resolver.js';
import {
  type BindingWithConnection,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
  listBindingsForProject,
} from './store.js';
import type { IntegrationProvider } from './types.js';

/** One MCP-injection provider entry in the preview (mirrors contracts type). */
export interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured row. */
  bindingId: string | null;
  environment: IntegrationEnvironment | null;
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: 'ok' | 'not_configured' | 'disabled' | 'no_credential' | 'shadowed' | 'not_declared';
  url: string | null;
  headers: Record<string, string> | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
}

/** The providers whose adapters inject an mcpServers entry at dispatch time. */
const MCP_PROVIDERS = ['postman', 'epodsystem', 'sentry'] as const;

function buildMcpEntryFor(
  provider: (typeof MCP_PROVIDERS)[number],
  pair: BindingWithConnection,
): Record<string, unknown> {
  // Same builders the dispatch resolvers use — the URL can't drift from what a
  // runner actually receives. The key argument is a placeholder; the headers
  // are replaced wholesale below so secret bytes never reach the response.
  // The token argument is an empty placeholder for ALL providers — the preview
  // never carries secret bytes. For sentry (stdio) this means `env` holds an
  // empty SENTRY_ACCESS_TOKEN; the preview projection below reads only `url`
  // (null for stdio) and synthesizes its own redacted headers, so the env is
  // never serialized into the response.
  if (provider === 'sentry') return buildSentryMcpEntry(effectiveConfig(pair), '');
  return provider === 'postman'
    ? buildPostmanMcpEntry(effectiveConfig(pair), '')
    : buildEpodsystemMcpEntry(effectiveConfig(pair), '');
}

/**
 * Render exactly what the dispatch-time resolvers will inject into a runner's
 * `mcpServers` for this project — same builders, same active/secret filters,
 * same first-active-binding pick — so the UI can show a truthful "these MCP
 * servers reach your agents" panel without fabricating URLs client-side.
 * `Authorization` is redacted BY CONSTRUCTION (the real key is never built
 * into the preview entry).
 */
export async function buildMcpPreview(projectId: string): Promise<McpServerPreviewEntry[]> {
  const pairs = await listBindingsForProject(projectId);
  const servers: McpServerPreviewEntry[] = [];

  // ISS-623 W3 — a healthy, active, credentialed integration still does NOT
  // inject unless some stage (project-default or per-state) declares its
  // sentinel in `pipelineConfig.mcpServers`. Load the declared-name set once
  // (project-wide — this preview isn't scoped to one stage) so `willInject`
  // reflects the real ISS-581 opt-in gate instead of only active+credential.
  const [projectRow] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const pipelineConfig = (projectRow?.agentConfig as { pipelineConfig?: unknown } | null)
    ?.pipelineConfig as Parameters<typeof collectDeclaredMcpNames>[0] | undefined;
  const declaredMcpNames = collectDeclaredMcpNames(pipelineConfig ?? {});

  /** ISS-581 opt-in check for a preview row's serverName. */
  const isSentinelDeclared = (provider: (typeof MCP_PROVIDERS)[number]): boolean => {
    if (provider === 'epodsystem') {
      return [...declaredMcpNames].some((n) => n === 'epodsystem' || n.startsWith('epodsystem_'));
    }
    return declaredMcpNames.has(provider);
  };

  for (const provider of MCP_PROVIDERS) {
    const rows = pairs.filter((p) => p.binding.provider === provider);
    if (rows.length === 0) {
      servers.push({
        provider,
        serverName: provider,
        bindingId: null,
        environment: null,
        configured: false,
        active: false,
        willInject: false,
        reason: 'not_configured',
        url: null,
        headers: null,
        lastHealthStatus: null,
        lastHealthAt: null,
      });
      continue;
    }

    // ISS-558 — epodsystem injects N entries (one per active binding), each
    // with its own serverName. Other providers still pick one winner.
    const isEpodsystem = provider === 'epodsystem';
    // For non-epodsystem: resolve the winning binding once outside the loop.
    const resolverPick = isEpodsystem
      ? null
      : ((await listActiveBindingsForProjectProvider(projectId, provider))[0] ?? null);

    for (const pair of rows) {
      const active = pair.binding.active && pair.connection.active;
      const hasSecrets = pair.connection.secretsEnc !== null;
      const bindingLabel = ((pair.binding as Record<string, unknown>).label as string) ?? '';
      const serverName = isEpodsystem
        ? `epodsystem${bindingLabel ? `_${bindingLabel.replace(/-/g, '_')}` : ''}`
        : provider;
      // Epodsystem: every active+credentialed binding gets its own injected key.
      // Others: only the resolver's winning pick is injected; rest are shadowed.
      // ISS-623 W3 — none of that matters unless a stage actually declared the
      // sentinel; a connected+healthy+winning integration still won't inject.
      const wouldWinSlot =
        active && hasSecrets && (isEpodsystem || resolverPick?.binding.id === pair.binding.id);
      const sentinelDeclared = isSentinelDeclared(provider);
      const willInject = wouldWinSlot && sentinelDeclared;
      const entry = buildMcpEntryFor(provider, pair);
      servers.push({
        provider,
        serverName,
        bindingId: pair.binding.id,
        environment: pair.binding.environment as IntegrationEnvironment,
        configured: true,
        active,
        willInject,
        reason: willInject
          ? 'ok'
          : !active
            ? 'disabled'
            : !hasSecrets
              ? 'no_credential'
              : !wouldWinSlot
                ? 'shadowed'
                : 'not_declared',
        url: typeof entry.url === 'string' ? entry.url : null,
        headers: willInject ? { Authorization: 'Bearer [redacted]' } : null,
        lastHealthStatus: pair.connection.lastHealthStatus,
        lastHealthAt: toIso(pair.connection.lastHealthAt),
      });
    }
  }

  return servers;
}
