export const SKIPS_PATH = '.forge/test-skips.json';
export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
export const CONFIG_RE = /(^|\/)vitest[^/]*\.config\.(ts|mts|cts|js|mjs)$/;

const SKIP_STATEMENT_RE = /^describe\s*\.\s*(skip|skipIf|todo)\s*\(/;
const SKIP_BINDING_RE =
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*[^;]*\?\s*describe\s*:\s*describe\s*\.\s*skip\b/;

/** True when the line skips a whole suite, as opposed to mentioning that syntax. */
export function isSuiteSkip(line) {
  const t = line.trim();
  return SKIP_STATEMENT_RE.test(t) || SKIP_BINDING_RE.test(t);
}

export function judge({ testFiles, collectedPerRunner, declaredSkips, skipHits, unreadable }) {
  for (const [cfg, files] of Object.entries(collectedPerRunner)) {
    if (files === null) return { code: 2, reason: `\`vitest list\` failed for ${cfg}` };
  }
  if (Object.keys(collectedPerRunner).length === 0) {
    return { code: 2, reason: 'found no vitest config — nothing could collect anything' };
  }
  if (declaredSkips === null) return { code: 2, reason: `${SKIPS_PATH} is not readable JSON` };
  if (unreadable?.length) {
    return {
      code: 2,
      reason: `tracked but not on disk, so its skips could not be read: ${unreadable.join(', ')} — stage the deletion (\`git rm\`) or restore the file`,
    };
  }

  const collected = new Set(Object.values(collectedPerRunner).flat());
  const unreachable = testFiles.filter((f) => !collected.has(f));
  const undeclaredSkips = skipHits.filter((f) => collected.has(f) && !declaredSkips[f]);
  const code = unreachable.length + undeclaredSkips.length > 0 ? 1 : 0;
  return { code, unreachable, undeclaredSkips };
}
