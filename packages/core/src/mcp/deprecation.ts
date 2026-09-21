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

export function formatDeprecationHeader(toolNames: Iterable<string>): string {
  const parts: string[] = [];
  for (const name of toolNames) {
    const notice = NOTICES.get(name);
    if (notice) parts.push(`${notice.tool}=${notice.replacement}`);
  }
  return parts.sort().join(', ');
}
