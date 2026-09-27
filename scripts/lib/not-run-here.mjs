const GATED_HEADER =
  'A green here does not cover these — CI runs them, and ci-passed gates the merge:';
const OFF_TREE_HEADER =
  'Nor these, which ci-passed does not gate either — read them on the pull request:';

export function notRunHereLines(elsewhere, offTree) {
  if (elsewhere.length === 0) return [];
  const lines = ['', `  ${GATED_HEADER}`];
  for (const cmd of [...new Set(elsewhere)].sort()) lines.push(`    ${cmd}`);
  if (offTree.length > 0) {
    lines.push('', `  ${OFF_TREE_HEADER}`);
    for (const line of offTree) lines.push(`    ${line}`);
  }
  return lines;
}

export { GATED_HEADER, OFF_TREE_HEADER };
