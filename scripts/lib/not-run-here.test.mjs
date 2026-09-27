import { describe, expect, it } from 'vitest';
import { GATED_HEADER, notRunHereLines } from './not-run-here.mjs';

const CMDS = ['pnpm --filter @forge/core test:integration', 'pnpm --filter web-v2 test'];
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
    const lines = notRunHereLines(CMDS, OFF_TREE);
    expect(under(lines, GATED_HEADER)).toEqual(expect.arrayContaining(CMDS));
  });

  it('puts no off-tree check under a header claiming ci-passed gates it', () => {
    const lines = notRunHereLines(CMDS, OFF_TREE);
    expect(under(lines, GATED_HEADER)).not.toEqual(expect.arrayContaining(OFF_TREE));
  });

  it('names every off-tree check somewhere in the report', () => {
    const lines = notRunHereLines(CMDS, OFF_TREE);
    for (const entry of OFF_TREE) expect(lines.some((l) => l.includes(entry))).toBe(true);
  });

  it('prints no off-tree heading where there is no off-tree check', () => {
    const lines = notRunHereLines(CMDS, []);
    expect(lines.filter((l) => /^ {2}\S/.test(l))).toHaveLength(1);
  });

  it('prints nothing at all where no command is left to CI', () => {
    expect(notRunHereLines([], OFF_TREE)).toEqual([]);
  });
});
