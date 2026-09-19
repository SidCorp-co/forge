import commentDensity from "./rules/comment-density.js";
import noArbitrarySizes from "./design/no-arbitrary-sizes.js";
import noRawColors from "./design/no-raw-colors.js";
import noRawElements from "./design/no-raw-elements.js";
import maxConsecutiveCommentLines from "./rules/max-consecutive-comment-lines.js";
import noDuplicateComment from "./rules/no-duplicate-comment.js";
import noHistoricalNarration from "./rules/no-historical-narration.js";
import noPassThroughWrapper from "./rules/no-pass-through-wrapper.js";

export { DEFAULT_CONTRAST_THRESHOLDS, findContrastFailures } from "./design/contrast.js";
export {
  DEFAULT_INTERACTIVE,
  DEFAULT_INTERACTIVE_SIZE_FAMILIES,
  DEFAULT_SIZE_FAMILIES,
  DEFAULT_SIZE_UNITS,
  findArbitrarySizesInFiles,
} from "./design/no-arbitrary-sizes.js";
export {
  DEFAULT_RAMP_COMPANIONS,
  DEFAULT_RAMP_PREFIX,
  findRampGaps,
  TYPE_RAMP_DIRECTIVE,
} from "./design/type-ramp.js";
export { findRawColorsInFiles } from "./design/no-raw-colors.js";
export { importedStylesheets, withImportedSources } from "./design/stylesheets.js";
export { findRedundantOverrides, THEME_OVERRIDE_DIRECTIVE } from "./design/theme-overrides.js";
export {
  DEFAULT_AMBIGUOUS_PREFIXES,
  DEFAULT_TOKEN_NAMESPACES,
  DEFAULT_UTILITY_KEYWORDS,
  DEFAULT_VALUE_KEYWORDS,
  findUnknownTokens,
  UNKNOWN_TOKEN_DIRECTIVE,
} from "./design/unknown-tokens.js";
export { DEFAULT_PRIMITIVES, primitiveExports } from "./design/no-raw-elements.js";
export {
  COLOR_PROPERTIES,
  contrastRatio,
  DEFAULT_STYLESHEET_EXTENSIONS,
  findRawColors,
  NAMED_COLORS,
  NEUTRAL_COLOR_KEYWORDS,
  readColorTokens,
  readTokenSources,
  resolveTokenAliases,
  sourceFiles,
  stringLiterals,
  themePalettes,
} from "./design/tokens.js";

export {
  CROWDED_DIRECTORY_DIRECTIVE,
  directivesFor,
  FIX_POLICY,
  RULE_DIRECTIVES,
} from "./directives.js";
export { DESIGN_SYSTEM, findInlineWarningGaps } from "./inline-warning.js";
export { DEFAULT_MAX_FILES_PER_DIRECTORY, findCrowdedDirectories } from "./folder-size.js";
export {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_MARKUP_EXTENSIONS,
  SOURCE_EXTENSIONS,
  walkDirectories,
} from "./walk.js";
export { HANDOFF_PATTERNS, NARRATION_PATTERNS } from "./rules/no-historical-narration.js";
export {
  contentWords,
  DEFAULT_MIN_SENTENCE_LENGTH,
  DEFAULT_OVERLAP_FLOOR,
  DEFAULT_OVERLAP_THRESHOLD,
  findOverlaps,
  findOverlapsAgainst,
  overlap,
  splitSentences,
  STOP_WORDS,
} from "./text-overlap.js";

export const DEFAULT_MAX_FILE_CODE_LINES = 500;
export const DEFAULT_MAX_FUNCTION_CODE_LINES = 150;

/**
 * What a test file is not held to. A suite callback is one function to ESLint, so the
 * per-function cap would measure the suite instead of the test; and a raw control in a test is
 * a stub standing in for a screen, which no primitive's focus ring was ever going to reach.
 */
const TEST_EXEMPT_RULES = ["max-lines-per-function", "code-quality/no-raw-elements"];

export const DEFAULT_TEST_GLOBS = [
  "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/test/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/tests/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/__tests__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
];

const plugin = {
  meta: { name: "eslint-plugin-code-quality", version: "0.15.0" },
  rules: {
    "no-historical-narration": noHistoricalNarration,
    "comment-density": commentDensity,
    "no-duplicate-comment": noDuplicateComment,
    "max-consecutive-comment-lines": maxConsecutiveCommentLines,
    "no-pass-through-wrapper": noPassThroughWrapper,
    "no-raw-colors": noRawColors,
    "no-arbitrary-sizes": noArbitrarySizes,
    "no-raw-elements": noRawElements,
  },
  configs: {},
};

export const DEFAULT_MAX_COMMENT_RATIO = 0.15;
export const DEFAULT_MAX_CONSECUTIVE_COMMENT_LINES = 8;

/** Every rule this plugin can enable, and the options it enables one with. */
const RULE_OPTIONS = {
  "no-historical-narration": {},
  "comment-density": { maxRatio: DEFAULT_MAX_COMMENT_RATIO, minCommentLines: 0 },
  "no-duplicate-comment": {},
  "max-consecutive-comment-lines": { max: DEFAULT_MAX_CONSECUTIVE_COMMENT_LINES },
  "no-pass-through-wrapper": {},
  "no-raw-colors": {},
  "no-arbitrary-sizes": {},
  "no-raw-elements": {},
  "max-lines": { max: DEFAULT_MAX_FILE_CODE_LINES, skipBlankLines: true, skipComments: true },
  "max-lines-per-function": {
    max: DEFAULT_MAX_FUNCTION_CODE_LINES,
    skipBlankLines: true,
    skipComments: true,
    IIFEs: true,
  },
};

/** ESLint's own two, so they carry no namespace and a project copy silently replaces them. */
const CORE_RULES = new Set(["max-lines", "max-lines-per-function"]);

/** Meaningless without a token layer: every `#fff` would report. Off until `tokens` names one. */
const TOKEN_RULES = new Set(["no-raw-colors", "no-arbitrary-sizes"]);

/** Colour and size keep separate homes, so only the colour rule is told where colour lives. */
const COLOR_RULES = new Set(["no-raw-colors"]);

/** Nothing to point a report at without a design system. Off until `primitives` names one. */
const PRIMITIVE_RULES = new Set(["no-raw-elements"]);

const idFor = (name) => (CORE_RULES.has(name) ? name : `code-quality/${name}`);

/** The names `configure` answers to, which are also this CLI's `--<rule>=` flags. */
export const RULE_NAMES = Object.keys(RULE_OPTIONS);

/** What the gate blocks on: every rule this plugin owns, enabled here or not. */
export const RULE_IDS = RULE_NAMES.map(idFor);

/** The project's settings file, written by the setup CLI and read by the gate and the hook. */
export const SETTINGS_FILE = "code-quality.json";

/** Its sections that configure a check ESLint cannot answer. */
export const TOKEN_SECTIONS = ["stylesheets", "sizes", "typeRamp", "contrast", "unknownTokens"];

/** Flat config's own names, in the order ESLint itself resolves them. */
export const ESLINT_CONFIG_FILES = ["js", "mjs", "cjs", "ts", "mts", "cts"].map(
  (extension) => `eslint.config.${extension}`,
);

/**
 * The whole flat config, from one severity per rule. `"error"`, `"warn"` and `"off"`, or
 * `["warn", { …options }]` to tune one; anything unnamed is `"error"`, the rules waiting for a
 * project noun excepted. `tokens` names the file colours and sizes belong in and exempts it from
 * both; `primitives` names the design system product code may not reach past.
 */
export function configure({
  tokens,
  primitives,
  testGlobs = DEFAULT_TEST_GLOBS,
  ignores,
  ...asked
} = {}) {
  const unknown = Object.keys(asked).filter((name) => !(name in RULE_OPTIONS));
  if (unknown.length > 0) {
    throw new TypeError(`configure: no rule named ${unknown.join(", ")}`);
  }

  // The token file exempts itself from the rules that would report every line of it.
  const exempt =
    tokens &&
    [tokens.tokenSource, tokens.colorSource, ...(tokens.exemptFiles ?? [])].filter(Boolean);

  const rules = {};
  for (const [name, defaults] of Object.entries(RULE_OPTIONS)) {
    const token = TOKEN_RULES.has(name) && tokens !== undefined;
    const system = PRIMITIVE_RULES.has(name) && primitives !== undefined;
    // A rule waiting for a project noun is off until the section naming it arrives.
    const waiting = (TOKEN_RULES.has(name) && !token) || (PRIMITIVE_RULES.has(name) && !system);
    const wanted = asked[name] ?? (waiting ? "off" : "error");
    const [severity, options = {}] = Array.isArray(wanted) ? wanted : [wanted];
    if (severity === "off" || severity === 0) continue;

    const merged = { ...defaults, ...options };
    if (system) {
      // The section is the project's answer; options beside the severity tune it.
      for (const [key, value] of Object.entries(primitives)) merged[key] ??= value;
    }
    if (token) {
      if (tokens.tokenSource !== undefined) merged.tokenSource ??= tokens.tokenSource;
      if (COLOR_RULES.has(name)) {
        if (tokens.colorSource !== undefined) merged.colorSource ??= tokens.colorSource;
        if (tokens.colorReference !== undefined) {
          merged.colorReference ??= tokens.colorReference;
        }
      }
      // Per-rule exemptions are added to the token file's, never swapped for it.
      merged.exemptFiles = [...new Set([...exempt, ...(options.exemptFiles ?? [])])];
    }
    rules[idFor(name)] = [severity, merged];
  }

  const configs = [{ name: "code-quality", plugins: { "code-quality": plugin }, rules }];
  if (ignores !== undefined) configs.unshift({ name: "code-quality/ignores", ignores });
  const relaxed = Object.fromEntries(
    TEST_EXEMPT_RULES.filter((id) => rules[id] !== undefined).map((id) => [id, "off"]),
  );
  if (Object.keys(relaxed).length > 0 && testGlobs.length > 0) {
    configs.push({ name: "code-quality/tests", files: [...testGlobs], rules: relaxed });
  }
  return configs;
}

plugin.configs.recommended = configure();

export default plugin;
export const { configs, rules } = plugin;
