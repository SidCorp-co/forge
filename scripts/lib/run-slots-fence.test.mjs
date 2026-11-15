// @direct-test-of scripts/check-run-slots.mjs

import { describe, expect, it } from 'vitest';
import { fenceFaults, RULE, SHELL } from './run-slots-fence.mjs';

const hows = (rel, source) => fenceFaults(rel, source).map((f) => f.how);

describe('the subagent slot rule lives in one place (ISS-1245)', () => {
  it('admits the rule, its shell and the files that hold the box size', () => {
    expect(hows(RULE, 'export function slotsFor(projects, capacity) {}')).toEqual([]);
    expect(
      hows(SHELL, "import { slotsFor } from './run-slots.js';\nconst c = d.maxSubagents;"),
    ).toEqual([]);
    expect(hows('packages/core/src/devices/writes.ts', 'set({ maxSubagents })')).toEqual([]);
    expect(
      hows(
        'packages/core/src/devices/run-slots.test.ts',
        "import { slotsFor } from './run-slots.js';",
      ),
    ).toEqual([]);
  });

  it('refuses a second rule, a second caller and a size read elsewhere, each by name', () => {
    expect(hows('packages/core/src/masters/caps.ts', 'const slotsFor = () => 3;')).toEqual([
      `defines a slot rule beside ${RULE}`,
    ]);
    expect(
      hows(
        'packages/core/src/masters/read.ts',
        "import { slotsFor } from '../devices/run-slots.js';",
      ),
    ).toEqual([`imports the slot rule, which only ${SHELL} calls`]);
    expect(
      hows('packages/web-v2/src/features/agents/x.tsx', 'const cap = box.maxSubagents - 1;'),
    ).toEqual(["names the box's subagent size outside the files that declare, store and read it"]);
    expect(
      hows(
        'packages/runner/crates/runner-daemon/src/control/runs.rs',
        'let n = cfg.runner.max_subagents();',
      ),
    ).toEqual(["names the box's subagent size outside the files that declare, store and read it"]);
  });

  it('reads code, not what a comment says about it', () => {
    expect(
      hows('packages/core/src/masters/read.ts', '// slotsFor answers it; maxSubagents is the size'),
    ).toEqual([]);
  });
});
