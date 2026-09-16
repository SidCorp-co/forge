/**
 * ISS-1038 — the per-PROVIDER answer to "does this integration reach agents".
 *
 * Deliberately separate from `McpServerPreviewEntry` in `integrations.ts`,
 * which answers a per-BINDING question (which binding wins a provider's slot,
 * its health, the URL it resolves to). This one answers the question an
 * operator actually asks on the Integrations tab: is this provider declared,
 * by which scope, and may I change it. Both are computed from the same
 * declaration projection in core's `pipeline/mcp-catalog.ts`, so a row and a
 * header cannot report different things.
 *
 * The stored value behind all of this is a bare `true` under
 * `pipelineConfig.mcpServers.<provider>`. No credential is ever part of it:
 * the provider's key stays in the integration store and is rendered into a
 * dispatch payload only.
 */

/** A provider whose adapter injects an mcpServers entry at dispatch time. */
export type McpInjectionProvider = 'postman' | 'epodsystem' | 'sentry';

/** One provider's injection state for a project. */
export interface McpInjectionProviderState {
  provider: McpInjectionProvider;
  /**
   * The project default declares this provider's sentinel, so every dispatched
   * job, every core-hosted chat turn AND every resident master's pane gets it
   * (subject to an active, credentialed binding). This is what the panel's
   * control writes.
   */
  declaredDefault: boolean;
  /**
   * Issue statuses whose own `states[x].mcpServers` declares a matching
   * sentinel. A stage in this list gets the provider whatever the project
   * default says.
   */
  declaredStates: string[];
  /**
   * Issue statuses whose `states[x].mcpServers` turns a project-default
   * declaration back off. Empty unless `declaredDefault` is true. A resident
   * master's pane stands at no status, so nothing here reaches it.
   */
  excludedStates: string[];
  /** Some binding for this provider exists on the project, active or not. */
  configured: boolean;
}

/** Envelope for `GET /:projectId/integrations/mcp-injection`. */
export interface McpInjectionStateResponse {
  providers: McpInjectionProviderState[];
  /**
   * Whether THIS caller may write. Readable by any project member; only org
   * owner/admin may change it, and the server is the only party that knows
   * which the caller is — so the control's enabled state comes from here
   * rather than from anything the client derives.
   */
  canEdit: boolean;
}

/** Body of `PUT /:projectId/integrations/mcp-injection/:provider`. */
export interface McpInjectionUpdateInput {
  /** true writes the bare sentinel; false removes that one key. */
  enabled: boolean;
}
