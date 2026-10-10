// The web lint's report: ESLint's own stylish listing, then how many files the run read. `pnpm verify`
// reads that count (scripts/lib/verify-checks.mjs, `web lint`) to prove the lint covered the tree; a
// clean stylish run prints nothing, which cannot tell a pass from a run that read no file.

/** @type {import("eslint").ESLint.FormatterFunction} */
export default async function countFormatter(results, context) {
  const { ESLint } = await import("eslint");
  const stylish = await new ESLint({ cwd: context.cwd }).loadFormatter("stylish");
  const listing = await stylish.format(results, context);
  return `${listing}${listing ? "\n" : ""}Checked ${results.length} file(s)\n`;
}
