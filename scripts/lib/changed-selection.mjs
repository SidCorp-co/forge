// Which test files a changed-selection runs, as a decision separated from the
// running of it. `test-changed.mjs` collects the three inputs — every test file
// in the package, the ones vitest's graph reached, the ones that read the tree —
// and this says what to do with them.
//
// Pure on purpose: the bug this file exists to hold is an ordering one (a lane
// dropped at the last step), and an ordering bug is only provable where the
// decision can be called without a repo, a base revision or a vitest.

/**
 * @param {{ all: string[], selected: string[], always: string[], fullRunShare: number }} input
 * @returns {{ skip: boolean, full: boolean, files: string[], union: string[] }}
 *   `files` is what to pass vitest — empty means the whole suite, which is what
 *   vitest does with no filter and is only reached when `full` is true.
 */
export function selectionFor({ all, selected, always, fullRunShare }) {
  const union = [...new Set([...selected, ...always])].sort();

  if (union.length === 0) return { skip: true, full: false, files: [], union };

  const full = union.length > all.length * fullRunShare;
  return { skip: false, full, files: full ? [] : union, union };
}
