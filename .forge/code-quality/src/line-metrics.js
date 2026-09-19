export function isIgnoredComment(comment) {
  const text = comment.value.trim();
  return /^(?:eslint-(?:disable|enable)|@ts-(?:ignore|expect-error))/i.test(text);
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
// below touches every line twice.
const metricsCache = new WeakMap();

export function getLineMetrics(sourceCode) {
  const cached = metricsCache.get(sourceCode);
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
          !isIgnoredComment(comment) &&
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
  metricsCache.set(sourceCode, metrics);
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
