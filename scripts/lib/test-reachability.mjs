// The verdict half of check-test-reachability, kept apart from the CLI.
//
// Not a style split: the CLI spawns `vitest list` and calls `process.exit` at
// module scope, so a test importing it would launch three vitest runs and then
// kill its own runner. Nothing about that failure is obvious from the import.

export const SKIPS_PATH = '.forge/test-skips.json';
export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
export const CONFIG_RE = /(^|\/)vitest[^/]*\.config\.(ts|mts|cts|js|mjs)$/;

// cm:guard a suite-level skip only. `it.skip` on one case is a quarantine visible in the run output; a skipped DESCRIBE takes the whole file out while the runner still reports it as a passing file, which is the shape that hid the device-runner E2E for months.
// cm:guard both patterns are anchored at STATEMENT position, and that anchor is the rule. Matching `describe.skip(` anywhere on a line flags any file that quotes the syntax — this checker's own test file did, and it would have failed the gate the moment it was tracked. A checker that fires on documentation of itself gets an exemption written for it, and the exemption is where the next real one hides.
const SKIP_STATEMENT_RE = /^describe\s*\.\s*(skip|skipIf|todo)\s*\(/;
const SKIP_BINDING_RE =
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*[^;]*\?\s*describe\s*:\s*describe\s*\.\s*skip\b/;

/** True when the line skips a whole suite, as opposed to mentioning that syntax. */
export function isSuiteSkip(line) {
  const t = line.trim();
  return SKIP_STATEMENT_RE.test(t) || SKIP_BINDING_RE.test(t);
}

/**
 * `collectedPerRunner` maps config path -> collected file list, or `null` for a
 * runner that could not answer.
 *
 * Returns `{ code: 0 }`, `{ code: 1, unreachable, undeclaredSkips }`, or
 * `{ code: 2, reason }`.
 */
// cm:guard order matters: a runner that could not answer is exit 2 BEFORE any coverage is computed. Judging the remainder would report every file that runner owns as unreachable — a real-looking violation list produced by a broken measurement, which is worse than no measurement, because someone will act on it.
export function judge({ testFiles, collectedPerRunner, declaredSkips, skipHits }) {
  for (const [cfg, files] of Object.entries(collectedPerRunner)) {
    if (files === null) return { code: 2, reason: `\`vitest list\` failed for ${cfg}` };
  }
  if (Object.keys(collectedPerRunner).length === 0) {
    return { code: 2, reason: 'found no vitest config — nothing could collect anything' };
  }
  if (declaredSkips === null) return { code: 2, reason: `${SKIPS_PATH} is not readable JSON` };

  const collected = new Set(Object.values(collectedPerRunner).flat());
  const unreachable = testFiles.filter((f) => !collected.has(f));
  const undeclaredSkips = skipHits.filter((f) => collected.has(f) && !declaredSkips[f]);
  const code = unreachable.length + undeclaredSkips.length > 0 ? 1 : 0;
  return { code, unreachable, undeclaredSkips };
}
