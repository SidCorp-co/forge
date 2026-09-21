import path from "node:path";
import { DEFAULT_MARKUP_EXTENSIONS } from "../walk.js";
import { withImportedSources } from "./stylesheets.js";
import {
  contrastRatio,
  isTranslucentHex,
  parseHexColor,
  readSourceFiles,
  readTokenSources,
  resolveTokenAliases,
  stringLiterals,
  themePalettes,
} from "./tokens.js";

/**
 * WCAG 2.1 minimum ratios: 1.4.3 for text, and 1.4.11 for component boundaries
 * and focus indicators.
 */
export const DEFAULT_CONTRAST_THRESHOLDS = { text: 4.5, largeText: 3, nonText: 3 };

/**
 * A pair is checked against the token file, so the numbers track the theme
 * rather than a transcription of it. Not an ESLint rule: a token file plus every
 * screen that pairs two tokens is project-wide knowledge, and a per-file rule
 * would report the same pair once per file that mentions it.
 *
 * Not covered: a colour that only exists at runtime — composited, filtered, or
 * behind an opacity utility; a pair neither a class string nor `declaredPairs`
 * states; and any theme missing from `themes`. A waiver stands in every theme.
 */
function utilityPattern(kind) {
  return new RegExp(`(?:^|[\\s:])${kind}-([a-z0-9-]+)(?![\\w./[-])`, "g");
}

function resolveNeed(need, thresholds) {
  if (need === undefined) return thresholds.text;
  if (typeof need === "number") return need;
  const resolved = thresholds[need];
  if (resolved === undefined) {
    throw new TypeError(`Unknown contrast threshold "${need}": ${Object.keys(thresholds).join(", ")}`);
  }
  return resolved;
}

// A pair a className states outright: one background utility and one foreground
// utility on the same element. Utilities carrying an opacity or an arbitrary
// value are skipped — what they composite against is not in the token table.
function scanPairs({ roots, extensions, ignoredDirectories, tokenPrefix, tokenNames }) {
  const pairs = new Map();
  for (const [file, text] of readSourceFiles({ roots, extensions, ignoredDirectories })) {
    for (const literal of stringLiterals(text)) {
      const { value } = literal;
      const backgrounds = [...value.matchAll(utilityPattern("bg"))];
      const foregrounds = [...value.matchAll(utilityPattern("text"))];
      for (const background of backgrounds) {
        for (const foreground of foregrounds) {
          const bg = `${tokenPrefix}${background[1]}`;
          const fg = `${tokenPrefix}${foreground[1]}`;
          if (fg === bg || !tokenNames.has(fg) || !tokenNames.has(bg)) continue;
          const key = `${fg}|${bg}`;
          if (pairs.has(key)) continue;
          const source = path.relative(process.cwd(), file) || file;
          pairs.set(key, { fg, bg, why: `paired in ${source}`, source });
        }
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Contrast failures across every declared theme. `tokenFile` is required and has
 * no default: every project names its token file differently, and guessing one
 * would report a clean run over tokens that were never read.
 */
export function findContrastFailures({
  tokenFile,
  block,
  tokenPattern,
  sources,
  themes,
  tokenPrefix = "--color-",
  roots = ["."],
  extensions = DEFAULT_MARKUP_EXTENSIONS,
  ignoredDirectories,
  declaredPairs = [],
  allow = [],
  thresholds = DEFAULT_CONTRAST_THRESHOLDS,
  scanMarkup = true,
} = {}) {
  const palettes = themePalettes({ themes, tokenFile, block, tokenPattern, sources });
  const unread = ({ sources: from }) => from.length === 0 || from.some((source) => !source.file);
  if (palettes.some(unread)) {
    throw new TypeError(
      "findContrastFailures needs { tokenFile }: the CSS file the design tokens are declared in.",
    );
  }

  for (const pair of [...declaredPairs, ...allow]) {
    if (!pair.fg || !pair.bg) throw new TypeError("A contrast pair needs { fg, bg } token names.");
  }
  // A standing failure is a design decision someone owns, so it has to say so.
  for (const entry of allow) {
    if (!entry.why) throw new TypeError(`Allowing ${entry.fg} on ${entry.bg} needs a reason.`);
  }

  const limits = { ...DEFAULT_CONTRAST_THRESHOLDS, ...thresholds };
  const measured = palettes.map((palette) => ({
    ...palette,
    tokens: resolveTokenAliases(readTokenSources(withImportedSources(palette.sources))),
    failures: [],
    waivers: [],
  }));
  const waived = new Map(allow.map((entry) => [`${entry.fg}|${entry.bg}`, entry.why]));
  // Scanned once, against every theme: a name one theme misses is a rebinding gap.
  const tokenNames = new Set(measured.flatMap((palette) => [...palette.tokens.keys()]));
  const pairs = [
    ...declaredPairs.map((pair) => ({ ...pair, source: "declared" })),
    ...(scanMarkup
      ? scanPairs({ roots, extensions, ignoredDirectories, tokenPrefix, tokenNames })
      : []),
  ];

  for (const palette of measured) {
    const declaredIn = palette.sources.map((source) => source.file).join(", ");
    for (const pair of pairs) {
      const need = resolveNeed(pair.need, limits);
      const foreground = palette.tokens.get(pair.fg) ?? null;
      const background = palette.tokens.get(pair.bg) ?? null;
      const entry = {
        ...pair,
        theme: palette.name,
        need,
        foreground,
        background,
        ratio: null,
        reason: null,
      };

      if (foreground === null || background === null) {
        entry.reason = `unknown token — not declared in ${declaredIn}`;
      } else if (isTranslucentHex(foreground) || isTranslucentHex(background)) {
        entry.reason = "translucent token — contrast needs the colour it composites over";
      } else if (parseHexColor(foreground) === null || parseHexColor(background) === null) {
        entry.reason = "unsupported token value — contrast needs a hex colour";
      } else {
        entry.ratio = contrastRatio(foreground, background);
        if (entry.ratio >= need) continue;
        entry.reason = `${entry.ratio.toFixed(2)}:1, needs ${need}:1`;
      }

      const waiver = waived.get(`${pair.fg}|${pair.bg}`);
      // The pair's own `why` says where it renders; the waiver says why the
      // failure is allowed to stand, and a scanned pair has no room for the second.
      if (waiver === undefined) palette.failures.push(entry);
      else palette.waivers.push({ ...entry, waivedBecause: waiver });
    }
  }

  return {
    themes: measured,
    pairs,
    failures: measured.flatMap((palette) => palette.failures),
    waivers: measured.flatMap((palette) => palette.waivers),
  };
}
