const GATED_HEADER =
  'A green here does not cover these — CI runs them, and ci-passed gates the merge:';
const AFTER_MERGE_HEADER =
  'Nor these — CI runs them after the merge, on main and nightly, and ci-passed does not gate them:';
const OFF_TREE_HEADER =
  'Nor these, which ci-passed does not gate either — read them on the pull request:';

function section(header, entries) {
  if (entries.length === 0) return [];
  return ['', `  ${header}`, ...[...new Set(entries)].sort().map((e) => `    ${e}`)];
}

export function notRunHereLines(elsewhere, afterMerge, offTree) {
  if (elsewhere.length === 0 && afterMerge.length === 0) return [];
  return [
    ...section(GATED_HEADER, elsewhere),
    ...section(AFTER_MERGE_HEADER, afterMerge),
    ...(offTree.length > 0 ? ['', `  ${OFF_TREE_HEADER}`, ...offTree.map((l) => `    ${l}`)] : []),
  ];
}

export { AFTER_MERGE_HEADER, GATED_HEADER, OFF_TREE_HEADER };
