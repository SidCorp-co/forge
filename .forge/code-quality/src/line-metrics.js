/**
 * Directives this plugin knows without being told. A comment opening with one of these is an
 * argument the toolchain reads, not prose about the code, so no comment rule may measure it.
 */
export const DEFAULT_DIRECTIVES = ["eslint-disable", "eslint-enable", "@ts-ignore", "@ts-expect-error"];

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A project's toolchain has directive vocabularies this plugin cannot guess — `i18n-allow:` read
 * by one checker, `biome-ignore` by another — and their wording belongs to the tool consuming
 * them, which is why two sites waiving the same rule carry the same words. `additional` names
 * them; the built-in set always applies, because a comment rule that could be told to measure
 * `eslint-disable` as prose would be configured into a defect.
 */
export function directiveMatcher(additional = []) {
  const names = [...DEFAULT_DIRECTIVES, ...additional];
  return new RegExp(`^(?:${names.map(escape).join("|")})`, "i");
}

const DEFAULT_MATCHER = directiveMatcher();

export function isIgnoredComment(comment, matcher = DEFAULT_MATCHER) {
  return matcher.test(comment.value.trim());
}

/**
 * How a project says "I know, and here is why" to a rule: one marker, the escape word, and a
 * mandatory reason, since a waiver nobody had to justify is an exemption with better syntax.
 * Enumerating them is the point — the plugin's own vocabulary, not the cases met so far.
 */
export function waiverPattern(marker, escape) {
  return new RegExp(`${marker}:\\s*${escape}\\s*[—-]\\s*(\\S[^\\n]*)`);
}

export const PASS_THROUGH_WAIVER = waiverPattern("pass-through", "keep");
export const RAW_ELEMENT_WAIVER = waiverPattern("primitive", "none");
export const RESTATEMENT_WAIVER = waiverPattern("restated", "deliberate");
const WAIVERS = [PASS_THROUGH_WAIVER, RAW_ELEMENT_WAIVER, RESTATEMENT_WAIVER];

export const isWaiver = (comment) => WAIVERS.some((waiver) => waiver.test(comment.value));

function blockLineContent(line, lineNumber, comment) {
  let content = line;
  if (lineNumber === comment.loc.start.line) {
    content = content.slice(comment.loc.start.column + 2);
  }
  if (lineNumber === comment.loc.end.line) {
    const endColumn = comment.loc.end.column - 2;
    const startColumn = lineNumber === comment.loc.start.line ? comment.loc.start.column + 2 : 0;
    content = content.slice(0, Math.max(0, endColumn - startColumn));
  }
  return content.replace(/^\s*\*?\s?/, "").trim();
}

function isDecorative(content) {
  return content === "" || /^[\s*\-=~_#]+$/.test(content);
}

function commentHasContentOnLine(comment, line, lineNumber) {
  if (comment.type === "Line") return !isDecorative(comment.value.trim());
  if (comment.type !== "Block") return false;
  return !isDecorative(blockLineContent(line, lineNumber, comment));
}

function lineHasCode(sourceCode, lineNumber, commentsOnLine) {
  const lineStart = sourceCode.getIndexFromLoc({ line: lineNumber, column: 0 });
  const line = sourceCode.lines[lineNumber - 1] ?? "";
  const segments = [];
  let cursor = lineStart;

  for (const comment of commentsOnLine.sort((a, b) => a.range[0] - b.range[0])) {
    const start = Math.max(comment.range[0], lineStart);
    const end = Math.min(comment.range[1], lineStart + line.length);
    if (start > cursor) segments.push(sourceCode.text.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < lineStart + line.length) {
    segments.push(sourceCode.text.slice(cursor, lineStart + line.length));
  }
  return segments.some((segment) => segment.trim() !== "");
}

// Both comment rules ask for the same metrics on the same file, and the walk
// below touches every line twice. Keyed by the directive vocabulary as well as the file:
// two rules configured with different vocabularies do not see the same comment lines.
const metricsCache = new WeakMap();

export function getLineMetrics(sourceCode, matcher = DEFAULT_MATCHER) {
  const perFile = metricsCache.get(sourceCode) ?? new Map();
  const cached = perFile.get(matcher.source);
  if (cached) return cached;

  const commentsByLine = new Map();
  for (const comment of sourceCode.getAllComments()) {
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line += 1) {
      const comments = commentsByLine.get(line) ?? [];
      comments.push(comment);
      commentsByLine.set(line, comments);
    }
  }

  const codeLines = new Set();
  const commentLines = new Set();
  for (let lineNumber = 1; lineNumber <= sourceCode.lines.length; lineNumber += 1) {
    const line = sourceCode.lines[lineNumber - 1];
    const comments = commentsByLine.get(lineNumber) ?? [];
    if (
      comments.some(
        (comment) =>
          comment.type !== "Shebang" &&
          !isIgnoredComment(comment, matcher) &&
          // A waiver is the answer to a rule, not prose about the code: charging it to the density
          // budget makes the escape cost a comment line and pushes a file at the budget over it.
          !isWaiver(comment) &&
          commentHasContentOnLine(comment, line, lineNumber),
      )
    ) {
      commentLines.add(lineNumber);
    }
    if (lineHasCode(sourceCode, lineNumber, comments)) codeLines.add(lineNumber);
  }

  const metrics = { codeLines, commentLines };
  perFile.set(matcher.source, metrics);
  metricsCache.set(sourceCode, perFile);
  return metrics;
}

export function longestConsecutiveRun(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  let longest = [];
  let current = [];
  for (const line of sorted) {
    if (current.length === 0 || line === current.at(-1) + 1) current.push(line);
    else current = [line];
    if (current.length > longest.length) longest = [...current];
  }
  return longest;
}
