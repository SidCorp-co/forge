/** The comment-content axis: the four rules that measure prose. biome owns length; this owns what a comment says. */
export const COMMENT_RULES = [
  'code-quality/comment-density',
  'code-quality/max-consecutive-comment-lines',
  'code-quality/no-duplicate-comment',
  'code-quality/no-historical-narration',
];

const OWNED = new Set(COMMENT_RULES);

/** ESLint results to `{path: {rule: n}}`, per (file, rule): moving a comment inside a file is not a violation. */
export function tally(results, toRelative) {
  const measured = {};
  for (const result of results) {
    for (const message of result.messages ?? []) {
      if (message.severity !== 2 || !OWNED.has(message.ruleId)) continue;
      const file = toRelative(result.filePath);
      measured[file] ??= {};
      measured[file][message.ruleId] = (measured[file][message.ruleId] ?? 0) + 1;
    }
  }
  return measured;
}

/** Rules this axis owns that the project switched off — reporting nothing, which by count reads as clean. */
export function silentRules(config) {
  const rules = config?.rules ?? {};
  return COMMENT_RULES.filter((id) => {
    const entry = rules[id];
    if (entry === undefined) return true;
    const severity = Array.isArray(entry) ? entry[0] : entry;
    return severity === 'off' || severity === 0;
  });
}
