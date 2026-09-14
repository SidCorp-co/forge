/**
 * What the chat toolset may do, frozen.
 *
 * ISS-1005 moved the Forge UI's reply onto a door for a reader who holds a role.
 * That is a change to what the surface may SAY and must not become a change to
 * what it may DO — the issue's own rule is that `CHAT_TOOL_ALLOWLIST` is not
 * widened past its current fence, and the reason is measured rather than
 * cautious: `guards.ts` records that `data.relations` reached chat unclassified
 * in ISS-868 and let a room retract a live `blocks` edge.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:guard the two mocks stand in for a parsed environment and a database connection, never for the allowlist: `registry.ts` reaches `db/client.js` at module load. `CHAT_TOOL_ALLOWLIST` itself and every factory on it are real here, which is the only way this file can be about what it claims.
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../db/client.js', () => ({ db: {} }));

import { CHAT_TOOL_ALLOWLIST } from './registry.js';

// cm:guard the frozen set, and it is spelled out rather than counted: a count passes when one tool is swapped for another, and the whole point of this file is that WHICH tool and WHICH action are what a guard has to have been written for. A new entry here is a deliberate edit with a reviewer on it, which is what ISS-868 did not have.
const FROZEN: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  ['forge_issues', ['list', 'get', 'listTasks', 'create', 'update']],
  ['forge_comments', ['list', 'create']],
  ['forge_knowledge', ['list', 'get', 'search']],
  ['forge_memory.search', null],
  ['forge_projects.get', null],
  ['forge_pipeline_runs.get', null],
  ['forge_project_pipeline_runs', null],
  ['forge_metrics.project_step_durations', null],
  ['forge_metrics.project_timeseries', null],
];

const nameOf = (spec: (typeof CHAT_TOOL_ALLOWLIST)[number]): string =>
  spec.factory({ projectId: null, userId: null } as never).name;

describe('the chat tool allowlist', () => {
  it('holds exactly the tools it held when the browser moved onto the assistant', () => {
    expect(CHAT_TOOL_ALLOWLIST.map(nameOf)).toEqual(FROZEN.map(([name]) => name));
  });

  it('permits exactly the actions it permitted, tool by tool', () => {
    for (const [i, [name, actions]] of FROZEN.entries()) {
      const spec = CHAT_TOOL_ALLOWLIST[i];
      expect(spec, name).toBeDefined();
      expect(spec?.allowedActions ?? null, name).toEqual(actions);
    }
  });

  // cm:guard the WRITE actions are named again on their own, because this is the sentence the annotations above `buildProjectToolset` used to get wrong: the toolset is not read-only, and a reader who believes it is will not look for the guard that makes it safe (ISS-1005).
  it('is not read-only, and the writing tool carries a guard', () => {
    const issues = CHAT_TOOL_ALLOWLIST.find((s) => nameOf(s) === 'forge_issues');
    expect(issues?.allowedActions).toEqual(expect.arrayContaining(['create', 'update']));
    expect(issues?.guard).toBeTypeOf('function');
  });
});
