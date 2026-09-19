import { readTokenSources, resolveTokenAliases } from "./tokens.js";
import { DEFAULT_SIZE_UNITS } from "./no-arbitrary-sizes.js";

export const DEFAULT_RAMP_PREFIX = "--text-";
export const DEFAULT_RAMP_COMPANIONS = ["--line-height"];

// A ramp step measures a length. `--text-` is Tailwind's font-size namespace, but a
// project may also name a text colour `--text-muted`: an unfillable gap, not a step.
function isLength(value, units) {
  const suffixes = units.map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^-?\\d[\\d.]*(?:${suffixes})?$`).test(String(value).trim().toLowerCase());
}

export const TYPE_RAMP_DIRECTIVE =
  "Declare the companion beside the step it belongs to, in the token file. A step " +
  "without one is not a ramp entry; it is a loose number with a ramp's name.";

/**
 * Ramp steps missing a companion token. Tailwind resolves `--text-lg--line-height`
 * off the step's own name, so a step declared without one inherits whatever the
 * cascade last set — a different rhythm per surface, from a file that looks whole.
 */
export function findRampGaps({
  tokenFile,
  block,
  tokenPattern,
  sources,
  prefix = DEFAULT_RAMP_PREFIX,
  requires = DEFAULT_RAMP_COMPANIONS,
  units = DEFAULT_SIZE_UNITS,
} = {}) {
  const from = sources ?? (tokenFile ? [{ file: tokenFile, block, tokenPattern }] : []);
  if (from.length === 0) {
    throw new TypeError(
      "findRampGaps needs { tokenFile }: the CSS file the type ramp is declared in.",
    );
  }

  const tokens = readTokenSources(from);
  const resolved = resolveTokenAliases(tokens);
  const gaps = [];
  for (const token of tokens.keys()) {
    if (!token.startsWith(prefix)) continue;
    if (requires.some((suffix) => token.endsWith(suffix))) continue;
    if (!isLength(resolved.get(token), units)) continue;
    for (const suffix of requires) {
      const companion = `${token}${suffix}`;
      if (!tokens.has(companion)) gaps.push({ token, missing: companion });
    }
  }
  return gaps;
}
