/**
 * ISS-145 — the legacy tool names still answering, and what replaced them.
 *
 * A shim factory looks its own name up here and pushes it onto
 * `ctx.deprecations`; the HTTP handler reads that set after the transport
 * produces a response and emits `X-MCP-Deprecation`, so a caller migrates
 * without silently depending on a name that is going away.
 *
 * Two entries, not eleven: the other nine shim factories were deleted once
 * nothing named them, and a notice whose factory no longer exists can never
 * fire — it only makes the registry read like a bigger promise than it is.
 */

export interface DeprecationNotice {
  /** Legacy tool name (e.g. `forge_pipeline_runs.list`). */
  tool: string;
  /** Replacement, formatted as `<new_tool> (action=<action>)`. */
  replacement: string;
}

const NOTICES = new Map<string, DeprecationNotice>([
  [
    'forge_pipeline_runs.get',
    { tool: 'forge_pipeline_runs.get', replacement: 'forge_project_pipeline_runs (action=get)' },
  ],
  [
    'forge_pm.set_dependency',
    { tool: 'forge_pm.set_dependency', replacement: 'forge_project_pm (action=set_dependency)' },
  ],
]);

export function deprecationFor(toolName: string): DeprecationNotice | null {
  return NOTICES.get(toolName) ?? null;
}

/**
 * Format the per-request set of recorded deprecations into a single
 * comma-separated `X-MCP-Deprecation` header value. Stable order so tests
 * can match against it without depending on `Set` iteration ordering.
 */
export function formatDeprecationHeader(toolNames: Iterable<string>): string {
  const parts: string[] = [];
  for (const name of toolNames) {
    const notice = NOTICES.get(name);
    if (notice) parts.push(`${notice.tool}=${notice.replacement}`);
  }
  return parts.sort().join(', ');
}
