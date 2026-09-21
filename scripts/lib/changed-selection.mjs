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
