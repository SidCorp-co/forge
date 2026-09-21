import { fileTotal } from './debt-ratchet.mjs';

export const SIZE_RULES = new Set([
  'lint/style/noExcessiveLinesPerFile',
  'lint/complexity/noExcessiveLinesPerFunction',
]);

/** Scopes whose baseline records debt but which measured nothing — the shape a silent wipe takes. */
export function emptiedScopes(currentByScope, baselineByScope) {
  const out = [];
  for (const [scope, now] of currentByScope) {
    if (now === 0 && (baselineByScope.get(scope) ?? 0) > 0) out.push(scope);
  }
  return out;
}

/**
 * Compile one scope's `drain` declaration into a predicate over repo-relative paths.
 *
 * Returns null when the scope declares no drain, which is how web-v2 stays freeze-only.
 */
export function drainMatcher(scope) {
  const d = scope?.drain;
  if (d === undefined || d === null) return null;
  if (!d.include) throw new Error(`scope ${scope.cwd}: drain declares no include pattern`);
  const include = new RegExp(d.include);
  const exclude = d.exclude ? new RegExp(d.exclude) : null;
  return (file) => include.test(file) && !exclude?.test(file);
}

/**
 * Drain: a changed drainable file must come back strictly lower than its baseline.
 *
 * @param measured  `{path: {rule: n}}` for the whole scope set
 * @param baseline  `{path: {rule: n}}` as frozen
 * @param changed   repo-relative paths in this branch's delta
 * @param renamed   Map<newPath, oldPath> for paths git detected as renames
 * @param matchers  the non-null results of drainMatcher, one per scope
 */
export function drainFaults({ measured, baseline, changed, renamed, matchers }) {
  if (matchers.length === 0) return [];
  const faults = [];
  for (const file of changed) {
    if (!matchers.some((m) => m(file))) continue;
    const now = fileTotal(measured[file]);
    const from = renamed.get(file);
    if (from !== undefined) {
      const carried = fileTotal(baseline[from]);
      if (now > carried) {
        faults.push({
          file,
          reasons: [
            `renamed from ${from} carrying ${carried}, now ${now} — a move may not add debt`,
          ],
        });
      }
      continue;
    }
    const was = fileTotal(baseline[file]);
    if (was === 0) {
      if (now > 0) {
        faults.push({
          file,
          reasons: [`${now} diagnostic(s) in a file frozen at 0 — a file at zero stays at zero`],
        });
      }
      continue;
    }
    if (now >= was) {
      faults.push({
        file,
        reasons: [
          `${now} diagnostic(s), baseline ${was} — you touched this file, so leave it strictly lower (remove at least one)`,
        ],
      });
    }
  }
  return faults;
}

/** Merge measured per-scope totals into the baseline's immutable `original` map. */
export function mergeOriginal(existing, currentByScope) {
  const out = { ...(existing ?? {}) };
  for (const [scope, n] of currentByScope) if (out[scope] === undefined) out[scope] = n;
  return out;
}

/** `packages/core: 55 / 60 original (8% drained)` — one number per class, per item 5. */
export function drainedLine(scope, current, original) {
  if (typeof original !== 'number' || original <= 0) {
    return `  ${scope}: ${current} (no original recorded)`;
  }
  const pct = Math.round(((original - current) / original) * 100);
  return `  ${scope}: ${current} / ${original} original (${pct}% drained)`;
}
