import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { BindingRole } from '../db/schema.js';
import { resolveSessionMcpServers } from '../jobs/resolve-job-mcp-servers.js';
import { refuser } from '../lib/refusal.js';
import { grantHolds } from './agent-access.js';
import { listAgentGrantedBindings } from './agent-access-store.js';
import { directMcpIntegrations, mcpServerNameFor } from './registry.js';
import { toIso } from './route-helpers.js';
import { type BindingWithConnection, effectiveConfig, listBindingsForProject } from './store.js';
import type { IntegrationDeclaration, IntegrationProvider } from './types.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

export type McpServerPreviewReason =
  | 'ok'
  | 'not_configured'
  | 'disabled'
  | 'no_credential'
  | 'shadowed'
  | 'not_granted'
  | 'not_resolved';

/** One MCP server entry in the preview (mirrors contracts type). */
export interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured one. */
  bindingId: string | null;
  role: BindingRole | null;
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: McpServerPreviewReason;
  url: string | null;
  headers: Record<string, string> | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
}

export interface McpPreview {
  servers: McpServerPreviewEntry[];
}

function previewEntryFor(
  decl: IntegrationDeclaration,
  pair: BindingWithConnection,
): Record<string, unknown> | null {
  const path = decl.capabilities.agentPath;
  if (path.kind !== 'direct-mcp') return null;
  return path.buildEntry(effectiveConfig(pair), path.previewSecrets);
}

function notConfiguredRow(decl: IntegrationDeclaration): McpServerPreviewEntry {
  return {
    provider: decl.provider,
    serverName: mcpServerNameFor(decl, '') ?? decl.provider,
    bindingId: null,
    role: null,
    configured: false,
    active: false,
    willInject: false,
    reason: 'not_configured',
    url: null,
    headers: null,
    lastHealthStatus: null,
    lastHealthAt: null,
  };
}

function reasonFor(args: {
  willInject: boolean;
  active: boolean;
  hasSecrets: boolean;
  held: boolean;
  wouldWinSlot: boolean;
}): McpServerPreviewReason {
  // Order matters: the FIRST unmet condition is the one the operator should act on, and
  // `not_granted` sits above `shadowed` because an ungranted binding is never in the pick at all —
  // calling it shadowed would name a competitor that is not competing. `not_resolved` is last
  // because it is what is left when all four hold and the resolver still produced nothing: a
  // credential that would not decrypt, or a provider that built no entry.
  if (args.willInject) return 'ok';
  if (!args.active) return 'disabled';
  if (!args.hasSecrets) return 'no_credential';
  if (!args.held) return 'not_granted';
  if (!args.wouldWinSlot) return 'shadowed';
  return 'not_resolved';
}

interface Delivered {
  /** Bindings the resolver actually built an entry for. */
  bindings: ReadonlySet<string>;
  names: ReadonlySet<string>;
  /** Which binding holds each produced name; one another holds is shadowed, not unresolved. */
  heldBy: ReadonlyMap<string, string>;
}

async function integrationRows(
  projectId: string,
  pairs: BindingWithConnection[],
  delivered: Delivered,
): Promise<McpServerPreviewEntry[]> {
  const rows: McpServerPreviewEntry[] = [];
  for (const decl of directMcpIntegrations()) {
    const provider = decl.provider;
    const mine = pairs.filter((p) => p.binding.provider === provider);
    if (mine.length === 0) {
      rows.push(notConfiguredRow(decl));
      continue;
    }

    // The same query the resolver runs, so "which binding wins" is answered once. A provider
    // declaring `multiBinding` injects every granted binding under its own name (ISS-558); everyone
    // else takes row zero, oldest first, which is what makes the pick stable across dispatches.
    const granted = await listAgentGrantedBindings(projectId, provider);
    const multi = decl.capabilities.multiBinding;
    const winnerId = multi ? null : (granted[0]?.binding.id ?? null);

    for (const pair of mine) {
      const label = ((pair.binding as Record<string, unknown>).label as string) ?? '';
      const serverName = mcpServerNameFor(decl, label) ?? provider;
      // Keyed on the binding, never the name: two bindings of one provider can carry one name, so
      // one whose name an earlier granted binding holds is shadowed — `multiBinding` included.
      const willInject = delivered.bindings.has(pair.binding.id) && delivered.names.has(serverName);
      const holder = delivered.heldBy.get(serverName);
      const wouldWinSlot =
        (multi || winnerId === pair.binding.id) &&
        (holder === undefined || holder === pair.binding.id);
      const entry = previewEntryFor(decl, pair);
      rows.push({
        provider,
        serverName,
        bindingId: pair.binding.id,
        role: pair.binding.role as BindingRole,
        configured: true,
        active: pair.binding.active && pair.connection.active,
        willInject,
        reason: reasonFor({
          willInject,
          active: pair.binding.active && pair.connection.active,
          hasSecrets: pair.connection.secretsEnc !== null,
          held: grantHolds(decl, pair.binding),
          wouldWinSlot,
        }),
        url: typeof entry?.url === 'string' ? entry.url : null,
        headers: willInject ? { Authorization: 'Bearer [redacted]' } : null,
        lastHealthStatus: pair.connection.lastHealthStatus,
        lastHealthAt: toIso(pair.connection.lastHealthAt),
      });
    }
  }
  return rows;
}

/**
 * Every MCP server a project-wide agent session for this project receives, and every reason one of
 * them does not.
 *
 * `resolveSessionMcpServers` alone composes that set from the granted bindings; this reads its
 * answer rather than re-deriving half of it, so the panel and `GET /api/devices/me/mcp-servers`
 * cannot disagree about which servers reach an agent (ISS-1191). Its credential-bearing
 * `mcpServers` map is never touched: only the names come from it. `Authorization` is redacted BY
 * CONSTRUCTION (the real key is never built into the preview entry).
 */
export async function buildMcpPreview(projectId: string): Promise<McpPreview> {
  const [pairs, resolved] = await Promise.all([
    listBindingsForProject(projectId),
    resolveSessionMcpServers(projectId),
  ]);

  const carried = new Set(resolved.resolvedNames);
  const delivered: Delivered = {
    bindings: new Set(resolved.integrationServers.map((s) => s.bindingId)),
    names: carried,
    heldBy: new Map(resolved.integrationServers.map((s) => [s.name, s.bindingId])),
  };

  const servers = await integrationRows(projectId, pairs, delivered);
  const shown = new Set(servers.filter((row) => row.willInject).map((row) => row.serverName));
  const unshown = resolved.resolvedNames.filter((name) => !shown.has(name));
  if (unshown.length > 0) {
    throw refuse(
      'MCP_PREVIEW_UNCLAIMED',
      `project ${projectId} resolves ${unshown.map((n) => `\`${n}\``).join(', ')} for its agents, but no granted binding in the preview claims ${unshown.length === 1 ? 'it' : 'them'}. Every server an agent receives comes from a granted integration binding, so the preview refuses to answer rather than show an agent's set it cannot account for.`,
    );
  }
  return { servers };
}
