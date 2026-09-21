import type { ESLint, Linter } from "eslint";

export declare const DEFAULT_MAX_FILE_CODE_LINES: number;
export declare const DEFAULT_MAX_FUNCTION_CODE_LINES: number;
export declare const DEFAULT_MAX_COMMENT_RATIO: number;
export declare const DEFAULT_MAX_CONSECUTIVE_COMMENT_LINES: number;
export declare const DEFAULT_TEST_GLOBS: string[];
export declare const DEFAULT_OVERLAP_THRESHOLD: number;
export declare const DEFAULT_OVERLAP_FLOOR: number;
export declare const DEFAULT_MIN_SENTENCE_LENGTH: number;
export declare const STOP_WORDS: Set<string>;

export type OverlapUnit<L = unknown> = [L, string];
export type OverlapHit<L = unknown> = [number, OverlapUnit<L>, OverlapUnit<L>];
export interface OverlapOptions {
  threshold?: number;
  floor?: number;
}

export declare function splitSentences(text: string, minLength?: number): string[];
export declare function contentWords(sentence: string): Set<string>;
export declare function overlap(a: Set<string>, b: Set<string>, floor?: number): number | null;
export declare function findOverlaps<L>(units: OverlapUnit<L>[], options?: OverlapOptions): OverlapHit<L>[];
export declare function findOverlapsAgainst<L>(
  incoming: OverlapUnit<L>[],
  existing: OverlapUnit<L>[],
  options?: OverlapOptions,
): OverlapHit<L>[];

export type Severity = "error" | "warn" | "off";

export interface DuplicateCommentOptions {
  /** Jaccard index at which two sentences are the same statement. Default `0.34`. */
  threshold?: number;
  /** Content words two sentences must share before the index is computed. Default `5`. */
  floor?: number;
  /** Characters below which a sentence is too short to compare. Default `40`. */
  minLength?: number;
}

export interface NarrationOptions {
  /** Patterns aimed at the next agent or migration stage. Default `true`. */
  handoffNarration?: boolean;
  /** Extra case-insensitive source patterns to reject. */
  additionalPatterns?: string[];
  /** Case-insensitive source patterns that exempt a comment. */
  allowPatterns?: string[];
}

export interface RawColorsOptions {
  tokenSource?: string;
  exemptFiles?: string[];
  colorProperties?: string[];
  namedColors?: string[];
  allow?: { file?: string; value: string; why: string }[];
}

export interface ArbitrarySizesOptions {
  tokenSource?: string;
  exemptFiles?: string[];
  everywhere?: unknown;
  onInteractive?: unknown;
  interactive?: unknown;
  units?: string[];
  allow?: { file?: string; value: string; why: string }[];
}

export interface PrimitiveEntry {
  /** The component that owns this element. Named in the report. */
  primitive: string;
  /** What the raw element drops by not being it. */
  owns: string;
  /** `type` values no primitive can own, e.g. `hidden` and `file` on an input. */
  exceptTypes?: string[];
}

export interface RawElementsOptions {
  /** Element → primitive. Replaces `DEFAULT_PRIMITIVES` wholesale. */
  primitives?: Record<string, PrimitiveEntry>;
  /** The design system's directory or barrel. Exempts itself; narrows reports to its exports. */
  source?: string;
  /** How product code imports it, for the message. Defaults to `source`. */
  importPath?: string;
  /** Class prefixes marking a heading as deliberately on the type ramp. */
  rampClasses?: string[];
  systemVariants?: boolean;
  exemptFiles?: string[];
}

/** A severity on its own, or one beside the options for that rule. */
export type RuleEntry<Options = Record<string, unknown>> = Severity | [Severity, Options];

export interface ConfigureOptions {
  "no-historical-narration"?: RuleEntry<NarrationOptions>;
  "comment-density"?: RuleEntry<{ maxRatio?: number; minCommentLines?: number }>;
  "no-duplicate-comment"?: RuleEntry<DuplicateCommentOptions>;
  "max-consecutive-comment-lines"?: RuleEntry<{ max?: number }>;
  "no-pass-through-wrapper"?: RuleEntry<{ elements?: boolean | string[] }>;
  "no-raw-colors"?: RuleEntry<RawColorsOptions>;
  "no-arbitrary-sizes"?: RuleEntry<ArbitrarySizesOptions>;
  /** Off unless named: without a design system to point at, every `<button>` reports. */
  "no-raw-elements"?: RuleEntry<RawElementsOptions>;
  "max-lines"?: RuleEntry<Linter.RuleSeverityAndOptions[1]>;
  "max-lines-per-function"?: RuleEntry<Linter.RuleSeverityAndOptions[1]>;
  /** The file colours and sizes belong in. Turns the two design rules on and exempts it. */
  tokens?: { tokenSource?: string; exemptFiles?: string[] };
  /** The design system product code may not reach past. Turns `no-raw-elements` on. */
  primitives?: Pick<RawElementsOptions, "source" | "importPath" | "rampClasses" | "primitives">;
  /** Globs the per-function cap is switched off for. Defaults to `DEFAULT_TEST_GLOBS`. */
  testGlobs?: string[];
  ignores?: string[];
}

/** Every rule id this plugin can enable, which is what the gate blocks on. */
export declare const RULE_IDS: string[];

/** The names `configure` answers to, which are also the setup CLI's `--<rule>=` flags. */
export declare const RULE_NAMES: string[];

/** The project settings file the setup CLI writes, and the gate and the hook read. */
export declare const SETTINGS_FILE: string;

/** Its sections that configure a check ESLint cannot answer. */
export declare const TOKEN_SECTIONS: string[];

/** Flat config's own names, in the order ESLint itself resolves them. */
export declare const ESLINT_CONFIG_FILES: string[];

export declare function configure(options?: ConfigureOptions): Linter.Config[];

export declare const NARRATION_PATTERNS: RegExp[];
export declare const HANDOFF_PATTERNS: RegExp[];

export declare const FIX_POLICY: string;
export declare const RULE_DIRECTIVES: Record<string, string>;
export declare const CROWDED_DIRECTORY_DIRECTIVE: string;
/** The unique remedy lines for the given rule ids, in first-seen order. */
export declare function directivesFor(ruleIds: Iterable<string>): string[];

export declare const DEFAULT_MAX_FILES_PER_DIRECTORY: number;
export declare const DEFAULT_IGNORED_DIRECTORIES: Set<string>;
export declare const SOURCE_EXTENSIONS: Set<string>;

export interface CrowdedDirectory {
  directory: string;
  count: number;
}

export declare function findCrowdedDirectories(options?: {
  roots?: string[];
  max?: number;
  ignoredDirectories?: Set<string>;
  extensions?: Set<string>;
}): CrowdedDirectory[];

export interface InlineWarningFinding {
  file: string;
  line?: number;
  component: string;
  reason: string;
}

export declare const DESIGN_SYSTEM: RegExp;

/** Form controls that cannot announce an error at the control. Worktrees are never scanned. */
export declare function findInlineWarningGaps(options?: {
  roots?: string[];
  /** Judge feature screens too, not the design system alone. */
  all?: boolean;
}): {
  files: string[];
  controlCount: number;
  waivers: InlineWarningFinding[];
  violations: InlineWarningFinding[];
};

/** The elements a primitive owns by default: the form controls and `h1`–`h4`. */
export declare const DEFAULT_PRIMITIVES: Record<string, PrimitiveEntry>;

/**
 * What a design system exports, read off its barrel and cached. `null` where the source
 * could not be read, which reports every element rather than passing them silently.
 */
export declare function primitiveExports(source: string): Set<string> | null;

export declare const NAMED_COLORS: string[];
export declare const NEUTRAL_COLOR_KEYWORDS: string[];
export declare const COLOR_PROPERTIES: string[];
export declare const DEFAULT_STYLESHEET_EXTENSIONS: string[];
export declare const DEFAULT_MARKUP_EXTENSIONS: string[];
export declare const DEFAULT_SIZE_UNITS: string[];

export interface SizeFamily {
  /** Named in the report: "font size", "radius", "padding". */
  name: string;
  /** Tailwind utility prefixes, matched exactly — `rounded-tl`, not `rounded`. */
  prefixes: string[];
  /** The same family written as a declaration: a style-object key or a CSS property. */
  properties?: string[];
  /** The remedy printed with the finding. */
  hint?: string;
}

export declare const DEFAULT_SIZE_FAMILIES: SizeFamily[];
export declare const DEFAULT_INTERACTIVE_SIZE_FAMILIES: SizeFamily[];
export declare const DEFAULT_INTERACTIVE: {
  elements: string[];
  roles: string[];
  attributes: string[];
  classNames: string[];
};

/** One permitted literal, optionally in one file, and why no token fits. */
export interface AllowedValue {
  file?: string;
  value: string;
  why: string;
}

export interface RawColor {
  /** Where the value starts in the text it was found in. */
  index: number;
  /** How much text the value covers, for a report that highlights it. */
  length: number;
  kind: string;
  value: string;
}

/** Raw colours in a string of text, `var()` and `url()` excluded. */
export declare function findRawColors(
  text: string,
  options?: { colorProperties?: string[]; namedColors?: string[] },
): RawColor[];

export interface RawColorInFile {
  file: string;
  line: number;
  kind: string;
  value: string;
}

/** The colour ban over stylesheets, which ESLint does not parse. */
export declare function findRawColorsInFiles(options?: {
  roots?: string[];
  extensions?: string[];
  exemptFiles?: string[];
  allow?: AllowedValue[];
  colorProperties?: string[];
  namedColors?: string[];
  ignoredDirectories?: Set<string>;
}): RawColorInFile[];

export interface ArbitrarySizeInFile {
  file: string;
  line: number;
  /** The family's name — "font size". */
  family: string;
  value: string;
  /** The family's remedy, so a caller can print the finding without the family. */
  hint: string;
}

/** The size ban over stylesheets, for families that name a CSS `properties` list. */
export declare function findArbitrarySizesInFiles(options?: {
  roots?: string[];
  extensions?: string[];
  exemptFiles?: string[];
  allow?: AllowedValue[];
  families?: SizeFamily[];
  units?: string[];
  ignoredDirectories?: Set<string>;
}): ArbitrarySizeInFile[];

export declare const DEFAULT_RAMP_PREFIX: string;
export declare const DEFAULT_RAMP_COMPANIONS: string[];
export declare const TYPE_RAMP_DIRECTIVE: string;

/** Ramp steps declared without a companion token, such as their line height. */
export declare function findRampGaps(options?: {
  tokenFile?: string;
  block?: string;
  tokenPattern?: string;
  sources?: TokenSource[];
  /** Default `--text-`. */
  prefix?: string;
  /** Suffixes every step must also declare. Default `["--line-height"]`. */
  requires?: string[];
}): { token: string; missing: string }[];

export declare const DEFAULT_CONTRAST_THRESHOLDS: {
  text: number;
  largeText: number;
  nonText: number;
};

export interface ContrastPair {
  fg: string;
  bg: string;
  /** A threshold name or a ratio. Defaults to `text`. */
  need?: keyof typeof DEFAULT_CONTRAST_THRESHOLDS | number;
  why?: string;
}

export interface ContrastFinding extends ContrastPair {
  /** The theme it was measured in, or `null` when the call declared none. */
  theme: string | null;
  need: number;
  foreground: string | null;
  background: string | null;
  ratio: number | null;
  /** Why it failed: the ratio, an unknown token, or a value contrast cannot resolve. */
  reason: string | null;
  /** `declared`, or the file the pair was scanned out of. */
  source: string;
  /** On a waiver only: the reason the failure is allowed to stand. */
  waivedBecause?: string;
}

/** Custom properties declared in a CSS file, optionally within one block. */
export declare function readColorTokens(
  file: string,
  options?: { block?: string; tokenPattern?: string },
): Map<string, string>;

/** WCAG 2.1 relative-contrast ratio between two hex colours. */
export declare function contrastRatio(foreground: string, background: string): number;

/** One file, or one block of one, that declares part of a theme. */
export interface TokenSource {
  file: string;
  block?: string;
  tokenPattern?: string;
}

/** The same tokens with every `var()` alias followed to the value it ends at. */
export declare function resolveTokenAliases(tokens: Map<string, string>): Map<string, string>;

/** Tokens from several files or blocks, merged in order, later sources winning. */
export declare function readTokenSources(sources: TokenSource[]): Map<string, string>;

/** One theme of a file that declares several, named so a failure can say which. */
export interface ContrastTheme {
  name: string;
  /** Blocks of `tokenFile`, layered in order: the base theme, then what rebinds it. */
  blocks?: string[];
  /** The same, spread over more than one file. One of `blocks` or `sources` is required. */
  sources?: TokenSource[];
  tokenFile?: string;
  tokenPattern?: string;
}

/** A theme after its sources are read, with the findings measured against it. */
export interface MeasuredTheme {
  name: string | null;
  sources: TokenSource[];
  tokens: Map<string, string>;
  failures: ContrastFinding[];
  waivers: ContrastFinding[];
}

/** Contrast over every declared theme. One of `tokenFile` or `sources` is required. */
export declare function findContrastFailures(options: {
  tokenFile?: string;
  block?: string;
  tokenPattern?: string;
  /** A theme spread over more than one file or block, innermost layer first. */
  sources?: TokenSource[];
  /** Every theme the project ships. One measured palette per entry; omit for one unnamed theme. */
  themes?: ContrastTheme[];
  tokenPrefix?: string;
  roots?: string[];
  extensions?: string[];
  ignoredDirectories?: Set<string>;
  declaredPairs?: ContrastPair[];
  allow?: ContrastPair[];
  thresholds?: Partial<typeof DEFAULT_CONTRAST_THRESHOLDS>;
  scanMarkup?: boolean;
}): {
  themes: MeasuredTheme[];
  pairs: ContrastPair[];
  /** Every theme's failures, in theme order. Each names the theme it came from. */
  failures: ContrastFinding[];
  waivers: ContrastFinding[];
};

/** One palette per theme, each a list of sources layered in order. */
export declare function themePalettes(options: {
  themes?: ContrastTheme[];
  tokenFile?: string;
  block?: string;
  tokenPattern?: string;
  sources?: TokenSource[];
}): { name: string | null; sources: TokenSource[] }[];

export declare const THEME_OVERRIDE_DIRECTIVE: string;

/** A theme declaration that restates the value already in force under it. */
export interface RedundantOverride {
  theme: string | null;
  token: string;
  value: string;
  /** The block it was declared in, or `null` for a source that named no block. */
  block: string | null;
}

/** Declarations a theme's own block could drop without changing a single colour. */
export declare function findRedundantOverrides(options: {
  tokenFile?: string;
  block?: string;
  tokenPattern?: string;
  sources?: TokenSource[];
  themes?: ContrastTheme[];
}): RedundantOverride[];

declare const plugin: ESLint.Plugin;

export default plugin;
export const configs: NonNullable<ESLint.Plugin["configs"]>;
export const rules: NonNullable<ESLint.Plugin["rules"]>;
