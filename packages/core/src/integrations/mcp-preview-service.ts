/**
 * MCP injection preview (ISS-429) — service behind
 * `GET /:projectId/integrations/mcp-preview` (thin handler in routes.ts).
 *
 * Mirrors dispatch-time semantics with the same entry builders, the same active+credential filters
 * and the same oldest-first winning-binding pick, but cannot reuse the dispatch resolver: that one
 * decrypts real vault credentials (the preview must never mint secret bytes) and returns only the
 * winning map, while this reports one row PER BINDING against every declared binding rather than
 * one dispatch's stage-resolved map.
 *
 * ISS-1071 changed both what this walks and what it measures. It walked a hardcoded
 * `MCP_PROVIDERS = ['postman','epodsystem','sentry']` and called three per-provider builders
 * through a two-branch ternary; it now walks `directMcpIntegrations()` and calls the builder the
 * declaration carries, so a fourth provider adds no line here. And `willInject` was gated on a
 * SENTINEL being declared somewhere in `pipelineConfig.mcpServers` — a map on a different settings
 * tab, which is how a binding could read Connected and healthy and reach no agent (ISS-1038). It is
 * now gated on the binding's own `agentAccess` grant, and the reason a binding does not inject is
 * `not_granted`, naming a switch that sits on the same object the operator is looking at.
 *
 * `resolveSessionMcpServers` runs the same chain minus the stage layer, so this describes chat
 * turns too.
 */
// cm:edge lockstep -> packages/core/src/integrations/mcp-resolver.ts — the gate order and the
// binding-pick order live in both files, and the preview lies about what a runner receives if they
// drift. The pair is deliberately NOT one shared function: that one decrypts, this one must not.

import { type BindingRole, type DeployStage } from '../db/schema.js';
import { grantHolds } from './agent-access.js';
import { directMcpIntegrations, mcpServerNameFor } from './registry.js';
import { toIso } from './route-helpers.js';
import {
  type BindingWithConnection,
  effectiveConfig,
  listAgentGrantedBindings,
  listBindingsForProject,
} from './store.js';
import type { IntegrationDeclaration, IntegrationProvider } from './types.js';

/** One MCP-injection provider entry in the preview (mirrors contracts type). */
export interface McpServerPreviewEntry {
  provider: IntegrationProvider;
  serverName: string;
  /** Binding id backing this entry — null for the synthetic not_configured row. */
  bindingId: string | null;
  role: BindingRole | null;
  stages: DeployStage[];
  configured: boolean;
  active: boolean;
  willInject: boolean;
  reason: 'ok' | 'not_configured' | 'disabled' | 'no_credential' | 'shadowed' | 'not_granted';
  url: string | null;
  headers: Record<string, string> | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
}

/**
 * The entry a runner would receive for one binding, built with an EMPTY secrets object.
 *
 * The same builder the dispatch resolver uses, so the URL cannot drift from what a runner actually
 * gets. The credential passed is the declaration's own `previewSecrets` placeholder, never the
 * stored one — that is the mechanism by which this response cannot carry secret bytes, and the
 * projection below then reads only `url` and synthesizes its own redacted `Authorization`, so a
 * builder that puts the placeholder in `env` never reaches the wire either.
 */
function previewEntryFor(
  decl: IntegrationDeclaration,
  pair: BindingWithConnection,
): Record<string, unknown> | null {
  const path = decl.capabilities.agentPath;
  if (path.kind !== 'direct-mcp') return null;
  return path.buildEntry(effectiveConfig(pair), path.previewSecrets);
}

/**
 * Render exactly what the dispatch-time resolver will inject into a runner's `mcpServers` for this
 * project — same builders, same active/secret/grant filters, same first-binding pick — so the UI
 * can show a truthful "these MCP servers reach your agents" panel without fabricating URLs
 * client-side. `Authorization` is redacted BY CONSTRUCTION (the real key is never built into the
 * preview entry).
 */
export async function buildMcpPreview(projectId: string): Promise<McpServerPreviewEntry[]> {
  const pairs = await listBindingsForProject(projectId);
  const servers: McpServerPreviewEntry[] = [];

  for (const decl of directMcpIntegrations()) {
    const provider = decl.provider;
    const rows = pairs.filter((p) => p.binding.provider === provider);
    if (rows.length === 0) {
      servers.push({
        provider,
        serverName: mcpServerNameFor(decl, '') ?? provider,
        bindingId: null,
        role: null,
        stages: [],
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

    // The same query the resolver runs, so "which binding wins" is answered once. A provider
    // declaring `multiBinding` injects every granted binding under its own name (ISS-558); everyone
    // else takes row zero, oldest first, which is what makes the pick stable across dispatches.
    const granted = await listAgentGrantedBindings(projectId, provider);
    const multi = decl.capabilities.multiBinding;
    const winnerId = multi ? null : (granted[0]?.binding.id ?? null);

    for (const pair of rows) {
      const active = pair.binding.active && pair.connection.active;
      const hasSecrets = pair.connection.secretsEnc !== null;
      const held = grantHolds(decl, pair.binding);
      const label = ((pair.binding as Record<string, unknown>).label as string) ?? '';
      const wouldWinSlot = multi || winnerId === pair.binding.id;
      const willInject = active && hasSecrets && held && wouldWinSlot;
      const entry = previewEntryFor(decl, pair);
      servers.push({
        provider,
        serverName: mcpServerNameFor(decl, label) ?? provider,
        bindingId: pair.binding.id,
        role: pair.binding.role as BindingRole,
        stages: (pair.binding.stages ?? []) as DeployStage[],
        configured: true,
        active,
        willInject,
        // Order matters: the FIRST unmet condition is the one the operator should act on, and
        // `not_granted` sits above `shadowed` because an ungranted binding is never in the pick at
        // all — calling it shadowed would name a competitor that is not competing.
        reason: willInject
          ? 'ok'
          : !active
            ? 'disabled'
            : !hasSecrets
              ? 'no_credential'
              : !held
                ? 'not_granted'
                : 'shadowed',
        url: typeof entry?.url === 'string' ? entry.url : null,
        headers: willInject ? { Authorization: 'Bearer [redacted]' } : null,
        lastHealthStatus: pair.connection.lastHealthStatus,
        lastHealthAt: toIso(pair.connection.lastHealthAt),
      });
    }
  }

  return servers;
}
