// The two comparisons check-lint-budget makes, with no I/O so they are testable.
//
// FREEZE is the old contract: a file already carrying debt may keep it and may
// lose it, never gain. DRAIN is the one ISS-833 asked for and nothing in this
// repo had — touch a file, leave its count STRICTLY lower. Freezing alone does
// not reduce: the codemap baseline sat frozen for months at 3% drained, which is
// the evidence that "not higher" and "lower when you edit it" are different
// rules, not two names for one.
//
// Drain is opt-in per scope. A scope with no `drain` block is freeze-only.

// cm:guard these two categories belong to check-size-budget.mjs, which freezes them by LINE COUNT. Counting them here as well would freeze the same debt under two directions of improvement, and a file that split one 300-line function into two would satisfy one checker while failing the other.
// cm:edge lockstep -> scripts/conformance-audit.mjs — R9 imports this set to decide which `warn` rule is size-budget's to count and which is lint-budget's; a category moving between the two checkers must move here, or R9 demands a baseline from the wrong one
export const SIZE_RULES = new Set([
  'lint/style/noExcessiveLinesPerFile',
  'lint/complexity/noExcessiveLinesPerFunction',
]);

/** Diagnostics in one file, summed across rules. */
export function fileTotal(rules) {
  return Object.values(rules ?? {}).reduce((a, n) => a + (typeof n === 'number' ? n : 0), 0);
}

/** Every file's diagnostics, summed. `files` is the baseline/measured `{path: {rule: n}}` shape. */
export function total(files) {
  return Object.values(files ?? {}).reduce((a, rules) => a + fileTotal(rules), 0);
}

/**
 * Compile one scope's `drain` declaration into a predicate over repo-relative paths.
 *
 * Returns null when the scope declares no drain, which is how web-v2 stays freeze-only.
 */
// cm:guard a `drain` block that will not compile is a REGISTRY error, so it throws rather than resolving to null. Returning null would silently demote that scope to freeze-only, which is a checker quietly stopping at half its contract on the strength of a typo — the caller turns this into exit 2.
export function drainMatcher(scope) {
  const d = scope?.drain;
  if (d === undefined || d === null) return null;
  if (!d.include) throw new Error(`scope ${scope.cwd}: drain declares no include pattern`);
  const include = new RegExp(d.include);
  const exclude = d.exclude ? new RegExp(d.exclude) : null;
  return (file) => include.test(file) && !exclude?.test(file);
}

/**
 * Freeze: no file may hold more of a rule than its baseline allows.
 *
 * `scope` limits which files are judged (pre-commit's staged set); null judges all.
 */
export function freezeFaults(measured, baseline, scope = null) {
  const faults = [];
  for (const [file, now] of Object.entries(measured)) {
    if (scope && !scope.has(file)) continue;
    const was = baseline[file] ?? {};
    const reasons = [];
    for (const [rule, count] of Object.entries(now)) {
      const allowed = was[rule] ?? 0;
      if (count > allowed) reasons.push(`${rule}: ${count} (baseline allowed ${allowed})`);
    }
    if (reasons.length) faults.push({ file, reasons });
  }
  return faults;
}

// cm:guard a RENAME is freeze-only, never drained. The baseline is path-keyed, so a moved file arrives as a new path carrying the same debt; asking it to also pay one would fire this rule on every move, and a rule that fires on renames is a rule someone turns off — the same reasoning compareDown's total carries in scripts/lib/baseline-ratchet.mjs.
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

// cm:guard `original` is the DENOMINATOR of every percent this repo will quote for a class, so --update-baseline may only ever add a missing key. Recomputing it would make "42% drained" mean "42% drained since the last re-freeze", which is a number that resets itself and can never fall — the unfalsifiable "trending to 0" ISS-833 exists to replace.
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
