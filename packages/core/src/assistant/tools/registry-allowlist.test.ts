/**
 * What the chat toolset may do, frozen.
 *
 * ISS-1005 moved the Forge UI's reply onto a door for a reader who holds a role.
 * That is a change to what the surface may SAY and must not become a change to
 * what it may DO — the issue's own rule is that `CHAT_TOOL_ALLOWLIST` is not
 * widened past its current fence.
 *
 * ISS-1007 added `forge_guide`, and added it CLASSIFIED: `list` and `get` only.
 * The tool also serves `upsert` and `delete`, whose only fence inside the
 * handler is an org-admin check that a signed-in chat principal may well pass,
 * so leaving `allowedActions` off would have been the unfenced key.
 *
 * ISS-1009 replaced the `forge_issues` / `forge_comments` wrappers with the one
 * `forge` CLI tool: the tracker's own refusals are the fence on what a room may
 * write, and a second door beside it is the one a model in a hurry takes.
 *
 * ISS-1034 added `forge_preferences` and `forge_memory.note`, the two writers
 * bound by core to the turn's linked speaker: neither takes a user, a source or
 * a ref, which is why `forge_memory.write` is still not beside them.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:guard the two mocks stand in for a parsed environment and a database connection, never for the allowlist: `CHAT_TOOL_ALLOWLIST` itself and every factory on it are real here, which is what lets the names below be read off the tools rather than off a fixture (ISS-1007).
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../db/client.js', () => ({ db: {} }));

import { forgeCommentsTool } from '../../mcp/tools/forge-comments.js';
import { forgeIssuesTool } from '../../mcp/tools/forge-issues.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { CHAT_TOOL_ALLOWLIST } from './registry.js';

// cm:guard the frozen set, and it is spelled out rather than counted: a count passes when one tool is swapped for another, and the whole point of this file is that WHICH tool and WHICH action are what a fence has been written for. `forge` is first because it is the door the persona names first (ISS-1007, ISS-1009).
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

  // cm:guard the two arms are named as ABSENT rather than the two present ones asserted, because `toEqual` on the pair would pass a day when `upsert` joined them: this is the assertion that has to fail if somebody widens the entry (ISS-1007).
  it('lets no writing arm of forge_guide reach a room', () => {
    const guide = CHAT_TOOL_ALLOWLIST.find((s) => nameOf(s) === 'forge_guide');
    expect(guide?.allowedActions).not.toContain('upsert');
    expect(guide?.allowedActions).not.toContain('delete');
  });

  // cm:guard neither wrapper may come back beside the CLI: measured 2026-09-15 with both offered, the model reached the wrapper for a status question, a duplicate check and a settings change while the persona named the CLI — two doors to one tracker is which one a model in a hurry takes, and the wrapper knows nothing of `forge new`'s neighbours, fold or shape (ISS-1009).
  it('offers the forge CLI first, and neither tracker wrapper', () => {
    const factories = CHAT_TOOL_ALLOWLIST.map((s) => s.factory);
    expect(factories[0]).toBe(forgeCliTool);
    expect(factories).not.toContain(forgeIssuesTool);
    expect(factories).not.toContain(forgeCommentsTool);
  });
});
