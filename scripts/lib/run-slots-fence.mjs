// How many subagents a project may run is decided in one place (ISS-1245): the pure rule
// `packages/core/src/devices/run-slots.ts:slotsFor`, called by its one shell,
// `packages/core/src/devices/run-slots-read.ts`. The prose caps it replaced drifted because every
// master could carry its own; a second place computing a count would drift the same way. This holds
// three lines:
//   1. `slotsFor` is defined in the rule's file alone;
//   2. the rule's file is imported by its shell alone (and its own test);
//   3. the box's size (`maxSubagents`, `max_subagents`) is read or written only where it is declared,
//      stored and handed to the shell — never where a count could be worked out beside the rule.

import { stripComments } from './gate.mjs';

export const RULE = 'packages/core/src/devices/run-slots.ts';
export const SHELL = 'packages/core/src/devices/run-slots-read.ts';

/** The files that may name the box's size, each for the one reason it does. */
export const SIZE_HOLDERS = {
  [SHELL]: 'reads it for the rule',
  'packages/core/src/db/schema-devices.ts': 'its column',
  'packages/core/src/devices/writes.ts': 'writes what the runner declared',
  'packages/core/src/devices/index.ts': "the devices module's face",
  'packages/core/src/masters/service.ts': 'stores it when a master registers',
  'packages/core/src/masters/device-routes.ts': 'hands the registration body to the service',
  'packages/contracts/src/master-standing.ts': 'the registration contract',
  'packages/runner/crates/runner-platform/src/config.rs': "the box's own config",
  'packages/runner/crates/runner-transport/src/master.rs': 'the registration body',
  'packages/runner/crates/runner-daemon/src/master/project.rs': 'registers the master with it',
};

/**
 * Files defining a function of the same name for another subject, each with what it counts. Not a
 * box's subagents, so not this rule's; a file that is moves under the rule instead.
 */
export const OTHER_SLOTS = {};

const SIZE = /\b(maxSubagents|max_subagents|setMaxSubagents)\b/;
const DEFINES_RULE = /\b(?:function\s+slotsFor|(?:const|let|var)\s+slotsFor\b|fn\s+slots_for\b)/;
const IMPORTS_RULE = /from\s+['"][^'"]*\/run-slots(?:\.js)?['"]/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isTest = (rel) => /\.test\.(ts|tsx|mjs)$/.test(rel) || rel.includes('/tests/');
// Rust comments are `//` too, and strings are not where these names are read.
const code = (rel, source) => (rel.endsWith('.sql') ? '' : stripComments(source));

/** Every line of `source` (the file at `rel`) that crosses the fence, as `{ rel, line, how }`. */
export function fenceFaults(rel, source) {
  const text = code(rel, source);
  const faults = [];
  const hit = (re, how) => {
    const m = re.exec(text);
    if (m) faults.push({ rel, line: lineOf(text, m.index), how });
  };
  if (rel !== RULE && !(rel in OTHER_SLOTS))
    hit(DEFINES_RULE, `defines a slot rule beside ${RULE}`);
  if (rel !== SHELL && !(isTest(rel) && rel.startsWith('packages/core/src/devices/run-slots'))) {
    hit(IMPORTS_RULE, `imports the slot rule, which only ${SHELL} calls`);
  }
  if (!(rel in SIZE_HOLDERS) && !isTest(rel)) {
    hit(SIZE, "names the box's subagent size outside the files that declare, store and read it");
  }
  return faults;
}
