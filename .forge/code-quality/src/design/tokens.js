import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_IGNORED_DIRECTORIES, DEFAULT_MARKUP_EXTENSIONS, walkDirectories } from "../walk.js";

/**
 * The vocabulary the design-system rules share: what counts as a colour, which
 * declarations take one, and how a token file is read back into values.
 */

// Accepted by every property whatever its type, so no namespace declares them; `transparent` and
// `currentColor` add the two that carry no colour, and every other name forks the token layer.
export const CSS_WIDE_KEYWORDS = ["inherit", "initial", "revert", "unset"];

export const NEUTRAL_COLOR_KEYWORDS = [
  ...CSS_WIDE_KEYWORDS,
  "currentcolor",
  "none",
  "transparent",
];

export const NAMED_COLORS = [
  "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue",
  "blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk",
  "crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki",
  "darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen",
  "darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue",
  "dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite",
  "gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki",
  "lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan",
  "lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen",
  "lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen",
  "magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen",
  "mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream",
  "mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid",
  "palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum",
  "powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown",
  "seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen",
  "steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow",
  "yellowgreen",
]
  .join("|")
  .split("|");

/** Declarations and JSX attributes whose value is a colour. */
export const COLOR_PROPERTIES = [
  "accent-color",
  "accentColor",
  "background",
  "background-color",
  "backgroundColor",
  "border-color",
  "borderColor",
  "box-shadow",
  "boxShadow",
  "caret-color",
  "caretColor",
  "color",
  "fill",
  "outline-color",
  "outlineColor",
  "stroke",
  "text-decoration-color",
  "textDecorationColor",
];

export const DEFAULT_STYLESHEET_EXTENSIONS = [".css", ".scss", ".sass", ".less"];

// A `#` after a word character or a slash opens a URL fragment, not a colour:
// `/docs#abcdef` and `?q=1#face` are hex-shaped and mean nothing of the sort.
const HEX = /(?<![\w/])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/g;
const VAR_REFERENCE = /var\(\s*--[\w-]+\s*\)/gi;
const URL_FUNCTION = /\burl\(\s*(?:"[^"\n]*"|'[^'\n]*'|[^)\n]*)\)/gi;
const NUMERIC_CHANNEL = /(?:^|[\s,(])[-+.]?\d/;

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const namedPatterns = new Map();

/**
 * A colour name only counts beside a colour declaration or inside a Tailwind
 * arbitrary value. A bare `navy` is a token name or a class fragment.
 */
function namedColorPattern(colorProperties, namedColors) {
  const key = `${colorProperties.join(",")}::${namedColors.join(",")}`;
  const cached = namedPatterns.get(key);
  if (cached) return cached;
  const properties = colorProperties.map(escapeForRegExp).join("|");
  const names = namedColors.map(escapeForRegExp).join("|");
  // The name is captured: a finding carries the colour, not the whole declaration.
  const pattern = new RegExp(
    `(?:(?:${properties})\\s*:\\s*["']?(${names})\\b)|(?:-\\[(${names})\\])`,
    "gdi",
  );
  namedPatterns.set(key, pattern);
  return pattern;
}

const blank = (match) => " ".repeat(match.length);

/**
 * A `var()` names a token and a `url()` names a document, so neither carries a
 * colour. Both are blanked to their own width, keeping every index aligned.
 */
function blankNonColors(text) {
  return text.replace(VAR_REFERENCE, blank).replace(URL_FUNCTION, blank);
}

/** The whole call opening at `start`, or null when its parentheses never close. */
function callText(text, start) {
  let depth = 0;
  for (let index = text.indexOf("(", start); index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** A call's channels, less its alpha: an opacity is not a colour and forks none. */
function colorChannels(call) {
  const name = call.slice(0, call.indexOf("(")).trim().toLowerCase();
  const args = call.slice(call.indexOf("(") + 1, -1);
  if (args.includes("/")) return args.slice(0, args.lastIndexOf("/"));
  const parts = args.split(",");
  const hasAlpha = parts.length === 4 || (parts.length > 1 && name.endsWith("a"));
  return (hasAlpha ? parts.slice(0, -1) : parts).join(",");
}

/**
 * A colour function passes when every channel is a token: `rgb(var(--brand) / .5)`
 * is the only way a token layer can express a colour at an opacity.
 */
function isTokenDriven(call) {
  const channels = colorChannels(call);
  const withoutTokens = channels.replace(VAR_REFERENCE, "");
  return withoutTokens !== channels && !NUMERIC_CHANNEL.test(withoutTokens);
}

/**
 * Raw colours in a piece of text. A finding carries the span it covers, for a
 * source location, and the value alone, which `allow` entries are written against.
 */
export function findRawColors(text, options = {}) {
  const { colorProperties = COLOR_PROPERTIES, namedColors = NAMED_COLORS } = options;
  const source = blankNonColors(text);
  const found = [];

  HEX.lastIndex = 0;
  for (const match of source.matchAll(HEX)) {
    found.push({
      index: match.index,
      length: match[0].length,
      kind: "hex literal",
      value: match[0],
    });
  }

  COLOR_FUNCTION.lastIndex = 0;
  for (const match of source.matchAll(COLOR_FUNCTION)) {
    // The call is read back out of the original text: its arguments were blanked
    // in `source`, and whether they name tokens is the whole question.
    const call = callText(text, match.index);
    if (call === null || isTokenDriven(call)) continue;
    found.push({
      index: match.index,
      length: call.length,
      kind: "colour function",
      value: call.trim(),
    });
  }

  const named = namedColorPattern(colorProperties, namedColors);
  named.lastIndex = 0;
  for (const match of source.matchAll(named)) {
    const [start, end] = match.indices[1] ?? match.indices[2];
    found.push({
      index: start,
      length: end - start,
      kind: "named CSS colour",
      value: source.slice(start, end),
    });
  }

  return found.sort((a, b) => a.index - b.index);
}

export function isNamedColor(value, namedColors = NAMED_COLORS) {
  return namedColors.includes(String(value).trim().toLowerCase());
}

/** The name a property or JSX attribute declares, or null when it is computed. */
export function keyName(node) {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function globToRegExp(glob) {
  const body = escapeForRegExp(glob)
    .replace(/\\\*\\\*\//g, "(?:.*/)?")
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`(?:^|/)${body}$`);
}

/** Paths are matched by tail, so a repository-relative entry finds an absolute file. */
export function matchesFile(filename, patterns = []) {
  if (!filename || patterns.length === 0) return false;
  const target = filename.split(path.sep).join("/");
  return patterns.some((entry) => {
    const pattern = entry.split(path.sep).join("/");
    if (pattern.includes("*")) return globToRegExp(pattern).test(target);
    return target === pattern || target.endsWith(`/${pattern}`);
  });
}

/** One entry permits one literal, optionally in one file — the shape is `ALLOW_ENTRY_SCHEMA`. */
export function isAllowedValue(allow, filename, value) {
  // A colour function is matched by its whole call, and the spacing inside one is
  // a formatter's decision, so neither side is compared on it.
  const normalize = (text) => String(text).toLowerCase().replace(/\s+/g, "");
  const wanted = normalize(value);
  return allow.some(
    (entry) =>
      normalize(entry.value) === wanted &&
      (entry.file === undefined || matchesFile(filename, [entry.file])),
  );
}

export function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

const STRING_LITERAL = /(["'`])((?:[^\\\n`]|\\.)*?)\1/g;

/**
 * Every quoted run, with the offset its value starts at. An interpolation stays
 * inside the value: what surrounds a `${}` is still the class string it opened.
 */
export function* stringLiterals(text) {
  for (const match of text.matchAll(STRING_LITERAL)) {
    yield { value: match[2], index: match.index + 1 };
  }
}

/** Source files under `roots`, for the checks a per-file lint rule cannot answer. */
export function sourceFiles({
  roots = ["."],
  extensions = DEFAULT_MARKUP_EXTENSIONS,
  ignoredDirectories = DEFAULT_IGNORED_DIRECTORIES,
} = {}) {
  const wanted = new Set(extensions.map((extension) => extension.toLowerCase()));
  const files = [];
  for (const { directory, entries } of walkDirectories(roots, { ignoredDirectories })) {
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (wanted.has(path.extname(entry.name).toLowerCase())) files.push(path.join(directory, entry.name));
    }
  }
  return files.sort();
}

// The four scans that read every file, given the text with it. Reading sits outside the yield:
// a consumer that throws resumes there, and inside the `try` looks like an unreadable file.
export function* readSourceFiles({ exemptFiles = [], ...options } = {}) {
  for (const file of sourceFiles(options)) {
    if (matchesFile(file, exemptFiles)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    yield [file, text];
  }
}

const COMMENT = /\/\*[\s\S]*?\*\//g;

/** Comments blanked to their own width, so a prose mention is never read as code. */
function withoutComments(css) {
  return css.replace(COMMENT, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * A block is found by the header that opens it, never by substring: `.dark` occurs in a comment
 * and in `:where(.dark, …)`, and a substring search takes whichever block came next.
 */
function blockStart(css, block) {
  const name = escapeForRegExp(block.trim()).replace(/\s+/g, "\\s+");
  const header = new RegExp(`(?<![\\w-])${name}\\s*\\{`);
  const match = header.exec(css);
  return match === null ? -1 : match.index + match[0].length - 1;
}

function blockBody(css, block, file) {
  const start = blockStart(css, block);
  // Loudly, because the alternative is measuring another block and reading green.
  if (start === -1) throw new Error(`No \`${block}\` block in ${file}`);
  let depth = 0;
  for (let end = start; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}" && (depth -= 1) === 0) return css.slice(start + 1, end);
  }
  throw new Error(`\`${block}\` is never closed in ${file}`);
}

/**
 * Custom properties declared in a CSS file. `block` narrows the read to one theme, which a file
 * declaring several needs: read whole, the last declaration wins and it is not the one measured.
 */
export function readColorTokens(file, { block, tokenPattern = "--[\\w-]+" } = {}) {
  const css = withoutComments(readFileSync(file, "utf8"));
  const scope = block === undefined ? css : blockBody(css, block, file);
  const tokens = new Map();
  const declaration = new RegExp(`(${tokenPattern})\\s*:\\s*([^;}]+)`, "gi");
  for (const match of scope.matchAll(declaration)) {
    tokens.set(match[1], match[2].trim().toLowerCase());
  }
  return tokens;
}

function hexDigits(value) {
  const text = String(value).trim();
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return null;
  const digits = text.slice(1);
  if (digits.length === 3 || digits.length === 4) {
    return [...digits].map((digit) => digit + digit).join("");
  }
  return digits;
}

/**
 * True for a hex colour carrying alpha. What it composites over is a fact about a
 * screen, so scoring it opaque would pass a pair that fails in the browser.
 */
export function isTranslucentHex(value) {
  const digits = hexDigits(value);
  return digits !== null && digits.length === 8 && digits.slice(6) !== "ff";
}

const ALIAS = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/i;

function resolveToken(tokens, name, seen) {
  const value = tokens.get(name);
  if (value === undefined || seen.has(name)) return value;
  const alias = ALIAS.exec(value);
  if (alias === null) return value;
  seen.add(name);
  const target = resolveToken(tokens, alias[1], seen);
  return target ?? (alias[2] === undefined ? value : alias[2].trim());
}

/**
 * The same tokens with every `var()` alias followed to the value it ends at. A
 * two-layer theme — semantic names over a raw palette — resolves to no colour at
 * all without this, and a contrast check that resolves nothing passes vacuously.
 */
export function resolveTokenAliases(tokens) {
  return new Map([...tokens.keys()].map((name) => [name, resolveToken(tokens, name, new Set())]));
}

/** Tokens from several files or blocks, merged in order, later sources winning. */
export function readTokenSources(sources) {
  const tokens = new Map();
  for (const { file, block, tokenPattern } of sources) {
    for (const entry of readColorTokens(file, { block, tokenPattern })) {
      tokens.set(entry[0], entry[1]);
    }
  }
  return tokens;
}

/**
 * One palette per theme, each a list of sources layered in order — a second theme is usually a
 * partial rebinding, so its block alone is half. Without `themes`, one unnamed palette.
 */
export function themePalettes({ themes, tokenFile, block, tokenPattern, sources }) {
  if (themes === undefined) {
    const one = sources ?? (tokenFile ? [{ file: tokenFile, block, tokenPattern }] : []);
    return [{ name: null, sources: one }];
  }
  return themes.map((theme) => {
    if (!theme.name) {
      throw new TypeError("A theme needs a { name }: a failure has to say which theme it is from.");
    }
    if (theme.sources === undefined && theme.blocks === undefined) {
      throw new TypeError(`Theme "${theme.name}" needs { blocks } or { sources } to read.`);
    }
    const layers =
      theme.sources ??
      theme.blocks.map((name) => ({
        file: theme.tokenFile ?? tokenFile,
        block: name,
        tokenPattern: theme.tokenPattern ?? tokenPattern,
      }));
    return { name: theme.name, sources: layers };
  });
}

/** sRGB channels of a hex colour, or null for a value this gate cannot resolve. */
export function parseHexColor(value) {
  const digits = hexDigits(value);
  if (digits === null || isTranslucentHex(value)) return null;
  return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16) / 255);
}

export function relativeLuminance(value) {
  const channels = parseHexColor(value);
  if (channels === null) throw new TypeError(`Not a hex colour: ${value}`);
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 relative-contrast ratio, 1 to 21. */
export function contrastRatio(foreground, background) {
  const [high, low] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (high + 0.05) / (low + 0.05);
}
