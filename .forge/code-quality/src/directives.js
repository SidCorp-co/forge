/**
 * The remedy text every surface prints: hook, gate, and skills. An agent that
 * read one must reach for the same structure as an agent that read another.
 */

const SPLIT_SHAPE =
  "Backend: a folder per feature (routes, service, repository). Frontend: components/, hooks/, lib/.";

export const FIX_POLICY =
  "Fix the source, not the check: no eslint-disable, no raised limit, no exemption entry.";

// Printed once per report, so only for a rule that both repeats and has an unguessable remedy.
export const RULE_DIRECTIVES = {
  "code-quality/no-duplicate-comment":
    'Two authorities for one constraint diverge the first time someone corrects only the copy they found. Keep the statement in one place, or waive it with "restated: deliberate — <reason>".',
  "code-quality/no-raw-elements":
    'Compose the primitive the design system exports, or waive it at the site with "primitive: none — <reason>".',
  "max-lines": `Split by responsibility, never at the line count. ${SPLIT_SHAPE} Move whole exports and re-export them from the original path.`,
  "max-lines-per-function":
    "Extract each independently testable step into a named function; split the file only if it then exceeds max-lines.",
};

export const CROWDED_DIRECTORY_DIRECTIVE = `Split by responsibility, never alphabetically. ${SPLIT_SHAPE} Move whole files and update their importers.`;

export function directivesFor(ruleIds) {
  const seen = new Set();
  for (const ruleId of ruleIds) {
    const directive = RULE_DIRECTIVES[ruleId];
    if (directive) seen.add(directive);
  }
  return [...seen];
}
