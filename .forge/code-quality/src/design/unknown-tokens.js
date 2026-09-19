import path from "node:path";
import { DEFAULT_MARKUP_EXTENSIONS } from "../walk.js";
import { withImportedSources } from "./stylesheets.js";
import {
  CSS_WIDE_KEYWORDS,
  lineOf,
  readSourceFiles,
  readTokenSources,
  resolveTokenAliases,
  stringLiterals,
  themePalettes,
} from "./tokens.js";

export const UNKNOWN_TOKEN_DIRECTIVE =
  "Declare the token, or name one that exists. A utility whose theme variable is " +
  "missing is not an error to Tailwind: it emits no rule at all, the element renders " +
  "unstyled, and — once class strings are merged — it displaces the utility before it.";

/** Utilities that take a colour. Sides are separate: `border-t-2` is a width. */
const COLOR_PREFIXES = [
  "accent",
  "bg",
  "border",
  "border-b",
  "border-e",
  "border-l",
  "border-r",
  "border-s",
  "border-t",
  "border-x",
  "border-y",
  "caret",
  "decoration",
  "divide",
  "drop-shadow",
  "fill",
  "from",
  "inset-ring",
  "inset-shadow",
  "outline",
  "placeholder",
  "ring",
  "ring-offset",
  "shadow",
  "stroke",
  "text",
  "text-shadow",
  "to",
  "via",
];

const RADIUS_PREFIXES = [
  "rounded",
  "rounded-b",
  "rounded-bl",
  "rounded-br",
  "rounded-e",
  "rounded-ee",
  "rounded-es",
  "rounded-l",
  "rounded-r",
  "rounded-s",
  "rounded-se",
  "rounded-ss",
  "rounded-t",
  "rounded-tl",
  "rounded-tr",
];

/**
 * Utility prefix → the theme namespaces its value may come from. A prefix listed
 * twice takes both: `text-sm` is a ramp step and `text-danger` is a colour, and
 * the utility alone cannot say which, so either resolving is enough.
 */
export const DEFAULT_TOKEN_NAMESPACES = [
  { prefixes: COLOR_PREFIXES, tokens: ["--color-"] },
  { prefixes: RADIUS_PREFIXES, tokens: ["--radius-"] },
  { prefixes: ["text"], tokens: ["--text-"] },
  { prefixes: ["shadow"], tokens: ["--shadow-"] },
  { prefixes: ["inset-shadow"], tokens: ["--inset-shadow-"] },
  { prefixes: ["drop-shadow"], tokens: ["--drop-shadow-"] },
  { prefixes: ["text-shadow"], tokens: ["--text-shadow-"] },
  { prefixes: ["font"], tokens: ["--font-", "--font-weight-"] },
  { prefixes: ["leading"], tokens: ["--leading-"] },
  { prefixes: ["tracking"], tokens: ["--tracking-"] },
  { prefixes: ["duration"], tokens: ["--duration-"] },
  { prefixes: ["ease"], tokens: ["--ease-"] },
  { prefixes: ["animate"], tokens: ["--animate-"] },
  { prefixes: ["blur", "backdrop-blur"], tokens: ["--blur-"] },
];

/**
 * Bare `var()` on these reads as a colour, so a length token silently compiles to
 * `border-color: 2px` — a declaration the browser drops. Measured against Tailwind
 * 4.3: `border-[var(--border-width-2)]` left a checkbox with no border in production.
 */
export const DEFAULT_AMBIGUOUS_PREFIXES = [
  "bg",
  "border",
  "border-b",
  "border-e",
  "border-l",
  "border-r",
  "border-s",
  "border-t",
  "border-x",
  "border-y",
  "divide",
  "outline",
  "ring",
  "ring-offset",
  "stroke",
  "text",
];

/** Values these namespaces take without a theme variable, from Tailwind 4.3's own utilities. */
export const DEFAULT_UTILITY_KEYWORDS = [
  "accent-auto,accent-color,bg-auto,bg-bottom,bg-bottom-left,bg-bottom-right,bg-center",
  "bg-clip-border,bg-clip-content,bg-clip-padding,bg-clip-text,bg-conic,bg-contain,bg-cover",
  "bg-fixed,bg-gradient-to-b,bg-gradient-to-bl,bg-gradient-to-br,bg-gradient-to-l",
  "bg-gradient-to-r,bg-gradient-to-t,bg-gradient-to-tl,bg-gradient-to-tr,bg-left",
  "bg-left-bottom,bg-left-top,bg-linear,bg-linear-to-b,bg-linear-to-bl,bg-linear-to-br",
  "bg-linear-to-l,bg-linear-to-r,bg-linear-to-t,bg-linear-to-tl,bg-linear-to-tr",
  "bg-local,bg-none,bg-no-repeat",
  "bg-origin-border,bg-origin-content,bg-origin-padding,bg-position,bg-radial,bg-repeat",
  "bg-repeat-round,bg-repeat-space,bg-repeat-x,bg-repeat-y,bg-right,bg-right-bottom",
  "bg-right-top,bg-scroll,bg-size,bg-top,bg-top-left,bg-top-right,border-b,border-be",
  "border-block,border-bottom,border-box,border-bs,border-collapse,border-color,border-dashed",
  "border-dotted,border-double,border-e,border-hidden,border-inline,border-l,border-left",
  "border-none,border-r,border-radius,border-right,border-s,border-separate,border-solid",
  "border-spacing,border-spacing-x,border-spacing-y,border-style,border-t,border-top",
  "border-width,border-x,border-y,caret-color,decoration-auto,decoration-clone,decoration-dashed",
  "decoration-dotted,decoration-double,decoration-from-font,decoration-slice,decoration-solid",
  "decoration-wavy,divide-color,divide-style,divide-x,divide-x-reverse,divide-y,divide-y-reverse",
  "duration-initial,fill-box,fill-none,font-family,font-features,font-feature-settings,font-size",
  "font-stretch,font-stretch-condensed,font-stretch-expanded,font-stretch-extra-condensed",
  "font-stretch-extra-expanded,font-stretch-normal,font-stretch-semi-condensed",
  "font-stretch-semi-expanded,font-stretch-ultra-condensed,font-stretch-ultra-expanded",
  "font-style,font-variant-numeric,font-variation-settings,font-weight,from-font,outline-color",
  "outline-dashed,outline-dotted,outline-double,outline-hidden,outline-none,outline-offset",
  "outline-solid,outline-style,outline-width,placeholder-color,placeholder-shown,ring-color",
  "ring-inset,ring-offset,ring-width,rounded-b,rounded-bl,rounded-br,rounded-e,rounded-ee",
  "rounded-es,rounded-full,rounded-l,rounded-none,rounded-r,rounded-s,rounded-se,rounded-ss",
  "rounded-t,rounded-tl,rounded-tr,shadow-initial,stroke-box,stroke-none,stroke-width",
  "text-align,text-balance,text-bottom,text-center,text-clip,text-decoration-color",
  "text-decoration-line,text-decoration-style,text-decoration-thickness,text-ellipsis,text-end",
  "text-indent,text-justify,text-left,text-nowrap,text-overflow,text-pretty,text-right",
  "text-shadow-initial,text-start,text-top,text-transform,text-underline-offset,text-wrap",
  "to-b,to-bl,to-br,to-l,to-r,to-t,to-tl,to-tr,via-none",
]
  .join(",")
  .split(",");

/** Suffixes every namespace takes: the CSS-wide keywords plus Tailwind's own words. */
export const DEFAULT_VALUE_KEYWORDS = [
  ...CSS_WIDE_KEYWORDS,
  "auto",
  "current",
  "full",
  "none",
  "transparent",
];

const NUMERIC = /^-?\d[\d.]*$/;
const LENGTH = /^-?(?:\d[\d.]*(?:px|rem|em|%|vh|vw|ch|pt|vmin|vmax|ex|cm|mm|in|pc|q)|0)$/i;
const VAR_ONLY = /^var\(\s*(--[\w-]+)\s*\)$/i;
const VAR_USE = /var\(\s*(--[\w-]+)\s*[,)]/gi;
const DECLARED = /(?:\[|["'\s{;,])(--[\w-]+)\s*:/g;
const NAMED = /["'](--[\w-]+)["']/g;
const QUOTE = /["'`]/g;

/** The `${…}` spans of a value, balanced so a `}` inside an object does not close one. */
function interpolations(value) {
  const spans = [];
  for (let start = 0; start < value.length - 1; start += 1) {
    if (value[start] !== "$" || value[start + 1] !== "{") continue;
    let depth = 0;
    for (let index = start + 1; index < value.length; index += 1) {
      if (value[index] === "{") depth += 1;
      else if (value[index] === "}") depth -= 1;
      if (depth > 0) continue;
      spans.push([start, index + 1]);
      start = index;
      break;
    }
  }
  return spans;
}

/**
 * A branch inside `${…}` holds classes, but the quotes around it are not part of them
 * and are what a word is split on: `${on ? 'bg-brand text-white' : ''}` ends a word at
 * `text-white'`, naming a token with a quote in it that no palette can declare. One
 * space for one quote, so every offset stays true of the file on disk.
 */
function withoutBranchQuotes(value) {
  let cleaned = value;
  for (const [start, end] of interpolations(value)) {
    cleaned =
      cleaned.slice(0, start) + cleaned.slice(start, end).replace(QUOTE, " ") + cleaned.slice(end);
  }
  return cleaned;
}

/**
 * Whether a literal is a list of classes at all. `class` is an attribute value, so a
 * quote can only reach one inside brackets — `content-['*']`. A quote outside them
 * says the literal is another language that happens to be space-separated: a CSP
 * header reads `font-src 'self' data:`, and `font-src` resolves as a utility asking
 * the theme for a font called `src`.
 */
function isClassList(value) {
  let depth = 0;
  for (const character of value) {
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    else if (depth === 0 && (character === '"' || character === "'" || character === "`")) {
      return false;
    }
  }
  return true;
}

/** A word that could be a class: no interpolation, no sentence punctuation. */
function isCandidate(word) {
  return word.length > 2 && /^-?[a-z0-9!@[]/.test(word) && !/[$&{}<>;]/.test(word);
}

/**
 * A candidate split into the variants it carries and the utility they qualify.
 * `:` inside brackets belongs to an arbitrary value — `data-[state=open]:` and
 * `bg-[color:var(--x)]` both contain one — so nesting is tracked, not assumed.
 */
function splitVariants(word) {
  const variants = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < word.length; index += 1) {
    const character = word[index];
    if (character === "[" || character === "(") depth += 1;
    else if (character === "]" || character === ")") depth -= 1;
    else if (character === ":" && depth === 0) {
      variants.push(word.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: word.slice(start) };
}

/** The utility without the modifiers that never reach the theme: `!`, `-`, `/50`. */
function bareUtility(utility) {
  const body = utility.replace(/^[-!]+/, "").replace(/!$/, "");
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "[") depth += 1;
    else if (body[index] === "]") depth -= 1;
    else if (body[index] === "/" && depth === 0) return body.slice(0, index);
  }
  return body;
}

function longestPrefix(utility, namespaces) {
  let found = null;
  for (const prefix of namespaces.keys()) {
    if (!utility.startsWith(`${prefix}-`)) continue;
    if (found === null || prefix.length > found.length) found = prefix;
  }
  return found;
}

function namespaceMap(namespaces) {
  const map = new Map();
  for (const { prefixes, tokens } of namespaces) {
    for (const prefix of prefixes) map.set(prefix, [...(map.get(prefix) ?? []), ...tokens]);
  }
  return map;
}

/** Where a name is absent. Null when every palette declares it. */
function missingFrom(palettes, names) {
  const absent = palettes.filter((palette) => !names.some((name) => palette.tokens.has(name)));
  return absent.length === 0 ? null : absent.map((palette) => palette.name);
}

/**
 * A utility whose value never comes from the theme. The number after one is part
 * of the utility, not a token name: `outline-offset-2` is `outline-offset`, and
 * reading it as `outline` plus `offset-2` asks for a colour called `offset-2`.
 */
function isKeyword(utility, keywords) {
  if (keywords.includes(utility)) return true;
  return keywords.some((keyword) => {
    if (!utility.startsWith(`${keyword}-`)) return false;
    const rest = utility.slice(keyword.length + 1);
    return NUMERIC.test(rest) || rest.startsWith("[");
  });
}

function classFinding({ word, utility, variants, namespaces, palettes, keywords, values }) {
  const prefix = longestPrefix(utility, namespaces);
  if (prefix === null || isKeyword(utility, keywords)) return null;
  const suffix = utility.slice(prefix.length + 1);
  if (suffix === "" || suffix.includes("[") || NUMERIC.test(suffix)) return null;
  if (values.includes(suffix)) return null;
  const names = namespaces.get(prefix).map((token) => `${token}${suffix}`);
  // A `dark:` utility is only ever read under the theme it names, so the other
  // palettes are not asked about it. Every other variant qualifies a state.
  const scoped = palettes.filter((palette) => variants.includes(palette.name));
  const missing = missingFrom(scoped.length > 0 ? scoped : palettes, names);
  if (missing === null) return null;
  return { kind: "unknown token", candidate: word, token: names[0], missing };
}

function ambiguousFinding({ word, utility, ambiguous, tokens }) {
  const open = utility.indexOf("-[");
  if (open === -1 || !utility.endsWith("]")) return null;
  const prefix = utility.slice(0, open);
  if (!ambiguous.includes(prefix)) return null;
  const value = VAR_ONLY.exec(utility.slice(open + 2, -1));
  if (value === null) return null;
  if (!LENGTH.test(tokens.get(value[1]) ?? "")) return null;
  return { kind: "ambiguous arbitrary value", candidate: word, token: value[1], missing: [] };
}

function scanClasses(text, options) {
  const found = [];
  for (const literal of stringLiterals(text)) {
    const value = withoutBranchQuotes(literal.value);
    if (!isClassList(value)) continue;
    for (const word of value.split(/\s+/)) {
      if (!isCandidate(word)) continue;
      const { variants, utility: qualified } = splitVariants(word);
      const utility = bareUtility(qualified);
      const finding =
        classFinding({ word, utility, variants, ...options }) ??
        ambiguousFinding({ word, utility, ...options });
      if (finding !== null) found.push({ ...finding, index: literal.index });
    }
  }
  return found;
}

/**
 * Every custom property the markup itself declares or names as a string. A
 * component sets its own — `[--card-pad:var(--card-padding-md)]`, a `style`
 * object, a font loader's `variable` — and those are not the token layer's to
 * declare. Collected across all scanned files, because the file that sets one is
 * rarely the file that reads it.
 */
function localProperties(texts) {
  const local = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(DECLARED)) local.add(match[1]);
    for (const match of text.matchAll(NAMED)) local.add(match[1]);
  }
  return local;
}

function scanReferences(text, { palettes, local, prefixes }) {
  const found = [];
  for (const match of text.matchAll(VAR_USE)) {
    const name = match[1];
    if (local.has(name) || !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const missing = missingFrom(palettes, [name]);
    if (missing === null) continue;
    found.push({
      kind: "unknown token",
      candidate: `var(${name})`,
      token: name,
      missing,
      index: match.index,
    });
  }
  return found;
}

/**
 * Utilities and `var()` references naming a theme variable no palette declares.
 *
 * Not seen: a token name assembled at runtime — `bg-${tone}`, `var(--color-${tone})`,
 * a `Record` keyed by a prop — because nothing in the source spells the name, which
 * is also why Tailwind itself cannot emit it; and a utility behind an arbitrary
 * variant (`[&>svg]:text-x`), whose brackets are skipped along with the prose that
 * would otherwise be read as classes.
 *
 * Nor whether a variable survives the build: Tailwind drops a `@theme` variable
 * no source names, so one reached only through an assembled name resolves to
 * nothing in the base theme while a `.dark` block, being a plain rule, still
 * emits it. `@theme static` is the answer to both.
 */
export function findUnknownTokens({
  tokenFile,
  block,
  tokenPattern,
  sources,
  themes,
  roots = ["."],
  extensions = DEFAULT_MARKUP_EXTENSIONS,
  ignoredDirectories,
  exemptFiles = [],
  namespaces = DEFAULT_TOKEN_NAMESPACES,
  ambiguous = DEFAULT_AMBIGUOUS_PREFIXES,
  keywords = DEFAULT_UTILITY_KEYWORDS,
  values = DEFAULT_VALUE_KEYWORDS,
  referencePrefixes = ["--color-"],
  checkReferences = true,
} = {}) {
  const declared = themePalettes({ themes, tokenFile, block, tokenPattern, sources });
  if (declared.some(({ sources: from }) => from.length === 0 || from.some((one) => !one.file))) {
    throw new TypeError(
      "findUnknownTokens needs { tokenFile }: the CSS file the design tokens are declared in.",
    );
  }

  const palettes = declared.map((palette) => ({
    ...palette,
    tokens: readTokenSources(withImportedSources(palette.sources)),
  }));
  const tokens = resolveTokenAliases(
    readTokenSources(withImportedSources(palettes.flatMap((one) => one.sources))),
  );
  const map = namespaceMap(namespaces);

  const read = new Map(readSourceFiles({ roots, extensions, exemptFiles, ignoredDirectories }));
  const local = localProperties(read.values());

  const violations = [];
  for (const [file, text] of read) {
    const found = [
      ...scanClasses(text, { namespaces: map, palettes, ambiguous, tokens, keywords, values }),
      ...(checkReferences
        ? scanReferences(text, { palettes, local, prefixes: referencePrefixes })
        : []),
    ];
    for (const entry of found) {
      violations.push({
        ...entry,
        file: path.relative(process.cwd(), file) || file,
        line: lineOf(text, entry.index),
      });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
