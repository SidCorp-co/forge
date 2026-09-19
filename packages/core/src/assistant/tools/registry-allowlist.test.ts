import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../db/client.js', () => ({ db: {} }));

import { forgeCommentsTool } from '../../mcp/tools/forge-comments.js';
import { forgeIssuesTool } from '../../mcp/tools/forge-issues.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { CHAT_TOOL_ALLOWLIST } from './registry.js';

const FROZEN: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  ['forge', null],
  ['forge_guide', ['list', 'get']],
  ['forge_knowledge', ['list', 'get', 'search']],
  ['forge_memory.search', null],
  ['forge_projects.get', null],
  ['forge_pipeline_runs.get', null],
  ['forge_project_pipeline_runs', null],
  ['forge_metrics.project_step_durations', null],
  ['forge_metrics.project_timeseries', null],
  ['forge_preferences', null],
  ['forge_memory.note', null],
];

const nameOf = (spec: (typeof CHAT_TOOL_ALLOWLIST)[number]): string =>
  spec.factory({ projectId: null, userId: null } as never).name;

describe('the chat tool allowlist', () => {
  it('holds exactly the tools it held when the speaker-bound writers joined', () => {
    expect(CHAT_TOOL_ALLOWLIST.map(nameOf)).toEqual(FROZEN.map(([name]) => name));
  });

  it('permits exactly the actions it permitted, tool by tool', () => {
    for (const [i, [name, actions]] of FROZEN.entries()) {
      const spec = CHAT_TOOL_ALLOWLIST[i];
      expect(spec, name).toBeDefined();
      expect(spec?.allowedActions ?? null, name).toEqual(actions);
    }
  });

  it('lets no writing arm of forge_guide reach a room', () => {
    const guide = CHAT_TOOL_ALLOWLIST.find((s) => nameOf(s) === 'forge_guide');
    expect(guide?.allowedActions).not.toContain('upsert');
    expect(guide?.allowedActions).not.toContain('delete');
  });

  it('offers the forge CLI first, and neither tracker wrapper', () => {
    const factories = CHAT_TOOL_ALLOWLIST.map((s) => s.factory);
    expect(factories[0]).toBe(forgeCliTool);
    expect(factories).not.toContain(forgeIssuesTool);
    expect(factories).not.toContain(forgeCommentsTool);
  });
});
