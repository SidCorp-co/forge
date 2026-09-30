import { describe, expect, it } from 'vitest';
import { AFTER_MERGE_HEADER, GATED_HEADER, notRunHereLines } from './not-run-here.mjs';

const CMDS = ['pnpm build', 'pnpm --filter web-v2 test'];
const AFTER = ['pnpm --filter @forge/core test:integration'];
const OFF_TREE = [
  'CodeQL — no workflow file here and not runnable locally; read its alerts on the PR',
];

function under(lines, header) {
  const start = lines.findIndex((l) => l.includes(header));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() === '' || /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim());
}

describe('notRunHereLines', () => {
  it('lists every command CI runs under the header saying ci-passed gates them', () => {
    const lines = notRunHereLines(CMDS, AFTER, OFF_TREE);
    expect(under(lines, GATED_HEADER)).toEqual([...CMDS].sort());
  });

  it('lists a command CI runs after the merge under its own header, and never as gated', () => {
    const lines = notRunHereLines(CMDS, AFTER, OFF_TREE);
    expect(under(lines, AFTER_MERGE_HEADER)).toEqual(AFTER);
    expect(under(lines, GATED_HEADER)).not.toContain(AFTER[0]);
  });

  it('puts no off-tree check under a header claiming ci-passed gates it', () => {
    const lines = notRunHereLines(CMDS, AFTER, OFF_TREE);
    expect(under(lines, GATED_HEADER)).not.toEqual(expect.arrayContaining(OFF_TREE));
  });

  it('names every off-tree check somewhere in the report', () => {
    const lines = notRunHereLines(CMDS, AFTER, OFF_TREE);
    for (const entry of OFF_TREE) expect(lines.some((l) => l.includes(entry))).toBe(true);
  });

  it('prints only the gated heading where nothing runs after the merge or off the tree', () => {
    const lines = notRunHereLines(CMDS, [], []);
    expect(lines.filter((l) => /^ {2}\S/.test(l))).toEqual([`  ${GATED_HEADER}`]);
  });

  it('still prints the after-merge heading where nothing left to CI gates the merge', () => {
    const lines = notRunHereLines([], AFTER, []);
    expect(under(lines, AFTER_MERGE_HEADER)).toEqual(AFTER);
    expect(lines.some((l) => l.includes(GATED_HEADER))).toBe(false);
  });

  it('prints nothing at all where no command is left to CI', () => {
    expect(notRunHereLines([], [], OFF_TREE)).toEqual([]);
  });
});
