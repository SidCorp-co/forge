// ISS-1229 r50, judge-152 on criterion 478: most screens offered Retry on a 403, 404 or 422, each deciding for
// itself (an unconditional onRetry, or a second rule that allowed everything but a 401). One rule decides now —
// `isRetryableApiError`, through `RetryButton` and the error-state primitives — and this test walks every
// component in the web app and refuses a Retry for a failed read that does not go through it (criterion 495).
// It also refuses a failure sentence closed by a second full stop (criterion 496: "You do not have access to this..").
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

/** The words a control that reads something again is drawn with. */
const RETRY_WORDS = new Set(["Retry", "Try again", "Retrying…"]);

/**
 * Files whose Retry repeats an act rather than a read, so no read's error decides it: each is named with
 * the act, as a whole file or as `file#words` where the same file also reads. Adding one here says, in
 * review, that its Retry is not a failed read's.
 */
const ACTS: Record<string, string> = {
  "design/primitives/retry-button.tsx": "the one Retry itself",
  "design/primitives/retry-link.tsx": "the one Retry itself, as a word",
  "features/integrations/components/delivery-log-viewer.tsx": "sends a failed webhook delivery again",
  "features/project-settings/components/memory-tab.tsx": "posts a failed reindex again",
  "features/conversations/components/conversation-thread.tsx": "sends a message that failed to send again",
  "features/project-dashboard/components/attention-queue.tsx#Retrying…": "runs a failed job again",
};

/** The one Retry, as a button or as a word inside a sentence: words inside either are its own. */
const RETRY_PRIMITIVES = new Set(["RetryButton", "RetryLink"]);

/** The primitives that draw a failed read's Retry: given onRetry, each must be given the read's error too. */
const FAILURE_PRIMITIVES = new Set(["ErrorState", "ReadFailedLine", "StaleReadLine"]);

/** Calls whose result is already a sentence: a template must not close it with a stop of its own. */
const SENTENCE_CALLS = new Set(["formatApiError", "formatApiReason", "couldNotRead", "couldNotReadAll"]);

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : components(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function insideRetryButton(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxElement(at) && RETRY_PRIMITIVES.has(tagName(at.openingElement))) return true;
  }
  return false;
}

function callName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  return ts.isIdentifier(callee) ? callee.text : null;
}

/** Every place in one file that breaks the rule, as `path:line what`. */
function offences(path: string, text: string): string[] {
  const rel = relative(SRC, path);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${what}`);

  const visit = (node: ts.Node) => {
    const words =
      ts.isJsxText(node) ? node.text.trim() : ts.isStringLiteral(node) && inJsx(node) ? node.text : null;
    if (words !== null && RETRY_WORDS.has(words) && !insideRetryButton(node) && !(rel in ACTS) && !(`${rel}#${words}` in ACTS)) {
      at(node, `draws "${words}" itself; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const attrs = node.attributes.properties;
      const named = (n: string) => attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText() === n);
      if (FAILURE_PRIMITIVES.has(name) && named("onRetry") && !named("error")) {
        at(node, `<${name}> is given onRetry without the failed read's error`);
      }
    }
    if (ts.isTemplateSpan(node) && SENTENCE_CALLS.has(callName(node.expression) ?? "") && node.literal.text.startsWith(".")) {
      at(node, "closes a sentence that already ends with its own stop");
    }
    if (ts.isJsxExpression(node) && node.expression && SENTENCE_CALLS.has(callName(node.expression) ?? "")) {
      const siblings = node.parent.getChildren(file).flatMap((c) => (c.kind === ts.SyntaxKind.SyntaxList ? c.getChildren(file) : [c]));
      const next = siblings[siblings.indexOf(node) + 1];
      if (next && ts.isJsxText(next) && next.text.startsWith(".")) at(node, "closes a sentence that already ends with its own stop");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function inJsx(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxExpression(at)) return true;
    if (ts.isJsxAttribute(at) || ts.isBlock(at) || ts.isSourceFile(at)) return false;
  }
  return false;
}

describe("a failed read's Retry, across the web app (criteria 478, 495, 496)", () => {
  it("is decided by the one rule everywhere: no component draws a Retry for a read by itself", () => {
    const all = components(SRC).flatMap((path) => offences(path, readFileSync(path, "utf8")));
    expect(all).toEqual([]);
  });

  it("is refused where a component draws its own Retry button", () => {
    const own = `export const A = ({ q }) => <p>Failed. <button onClick={() => q.refetch()}>Retry</button></p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), own)).toEqual([
      expect.stringContaining('draws "Retry" itself'),
    ]);
  });

  it("is refused where an error state is given its Retry without the read's error", () => {
    const bare = `export const A = ({ q }) => <ErrorState title="Couldn't load" message="x" onRetry={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/x/a.tsx"), bare)).toEqual([
      expect.stringContaining("given onRetry without the failed read's error"),
    ]);
  });

  it("passes a Retry drawn by RetryButton, whatever its words", () => {
    const via = `export const A = ({ q }) => <RetryButton error={q.error} onRetry={() => q.refetch()}>Try again</RetryButton>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), via)).toEqual([]);
  });

  it("refuses a second full stop after a failure sentence, in a template and in JSX", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
    const twice = "export const A = ({ e }) => <p>{`Could not: ${formatApiError(e)}.`} Runners: {formatApiError(e)}.</p>;";
    expect(offences(join(SRC, "features/x/a.tsx"), twice)).toHaveLength(2);
  });
});
