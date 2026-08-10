/**
 * ISS-145 — Deprecation registry for the legacy per-action MCP tool families
 * that were consolidated into `forge_project_pipeline_runs` and
 * `forge_project_pm`. Shim factories look up the deprecation notice for the
 * tool they implement and push the tool name onto `ctx.deprecations`; the
 * HTTP handler reads that set after the transport produces its response and
 * emits an `X-MCP-Deprecation` header so callers can migrate without
 * silently relying on a soon-to-be-removed name.
 */

export interface DeprecationNotice {
  /** Legacy tool name (e.g. `forge_pipeline_runs.list`). */
  tool: string;
  /** Replacement, formatted as `<new_tool> (action=<action>)`. */
  replacement: string;
}

const NOTICES = new Map<string, DeprecationNotice>([
  [
    'forge_pipeline_runs.list',
    { tool: 'forge_pipeline_runs.list', replacement: 'forge_project_pipeline_runs (action=list)' },
  ],
  [
    'forge_pipeline_runs.get',
    { tool: 'forge_pipeline_runs.get', replacement: 'forge_project_pipeline_runs (action=get)' },
  ],
  [
    'forge_pipeline_runs.pause',
    { tool: 'forge_pipeline_runs.pause', replacement: 'forge_project_pipeline_runs (action=pause)' },
  ],
  [
    'forge_pipeline_runs.resume',
    {
      tool: 'forge_pipeline_runs.resume',
      replacement: 'forge_project_pipeline_runs (action=resume)',
    },
  ],
  [
    'forge_pipeline_runs.cancel',
    {
      tool: 'forge_pipeline_runs.cancel',
      replacement: 'forge_project_pipeline_runs (action=cancel)',
    },
  ],
  [
    'forge_pm.snapshot',
    { tool: 'forge_pm.snapshot', replacement: 'forge_project_pm (action=snapshot)' },
  ],
  ['forge_pm.graph', { tool: 'forge_pm.graph', replacement: 'forge_project_pm (action=graph)' }],
  [
    'forge_pm.runner_load',
    { tool: 'forge_pm.runner_load', replacement: 'forge_project_pm (action=runner_load)' },
  ],
  [
    'forge_pm.dispatch',
    { tool: 'forge_pm.dispatch', replacement: 'forge_project_pm (action=dispatch)' },
  ],
  [
    'forge_pm.set_dependency',
    { tool: 'forge_pm.set_dependency', replacement: 'forge_project_pm (action=set_dependency)' },
  ],
  [
    'forge_pm.write_decision',
    { tool: 'forge_pm.write_decision', replacement: 'forge_project_pm (action=write_decision)' },
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
