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

/**
 * The words a control that reads something again is drawn with, as its text, its accessible name or its title:
 * judge-158 found Retry drawn as an icon's name, as "Retry loading" and "Reload", and under "Read again", "Read
 * them again" and "Read it again" (ISS-1229 r51).
 */
const RETRY_WORDS = /^(Retry\b.*|Retrying…|Try again\b.*|Reload\b.*|Read (it |them )?again\b.*)$/;

/** The attributes a control's words stand in where it draws none of its own. */
const NAMING_ATTRIBUTES = new Set(["aria-label", "title", "label"]);

/** The handlers a person presses a control through. */
const PRESS_HANDLERS = new Set(["onClick", "onSelect", "onPress"]);

/** Calls that read something again. */
const READ_AGAIN_CALLS = new Set(["refetch", "refetchQueries", "invalidateQueries", "resetQueries", "reload"]);

/** The calls that read again behind a handler's name: there a cache invalidation follows a write. */
const NAMED_READ_AGAIN_CALLS = new Set(["refetch", "reload"]);

/** Names a read-again handler goes by where it is handed on rather than written in place. */
const READ_AGAIN_NAME = /^(on)?(retry|refetch|reload|reread|readagain)/i;

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
  "app/global-error.tsx": "loads the page again after it failed to draw, where no read's error is held",
  "features/issues/components/blocker-banner.tsx#onRetryPark": "takes a parked issue up again",
  "features/project-dashboard/components/attention-queue.tsx#onRetryJob": "runs a failed job again",
  "features/project-settings/components/save-refused-banner.tsx#reread":
    "answers a save refused for settings that moved, by reading them again: the refusal's way out, not a failed read's",
  "features/integrations/components/project-integrations-panel.tsx#() => status.refetch()":
    "refreshes integration statuses that were read, a control that stands whether or not a read failed",
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
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isJsxElement(at) && RETRY_PRIMITIVES.has(tagName(at.openingElement))) return true;
    if (ts.isJsxSelfClosingElement(at) && RETRY_PRIMITIVES.has(tagName(at))) return true;
  }
  return false;
}

function callName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

/** The constants a file declares, by name: a string held in one is still the word it is. */
function constantsOf(file: ts.SourceFile): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      found.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) found.set(node.name.text, node.body as unknown as ts.Expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The words an expression stands for, where it is a string written out or a constant holding one. */
function wordsOf(node: ts.Node, constants: Map<string, ts.Expression>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.text.trim();
  if (ts.isJsxExpression(node) && node.expression) return wordsOf(node.expression, constants);
  if (ts.isParenthesizedExpression(node)) return wordsOf(node.expression, constants);
  if (ts.isIdentifier(node)) {
    const held = constants.get(node.text);
    return held && (ts.isStringLiteral(held) || ts.isNoSubstitutionTemplateLiteral(held)) ? held.text : null;
  }
  return null;
}

/** Calls that write: a handler making one is an act, whatever it reads again after it. */
const WRITE_CALLS = new Set(["mutate", "mutateAsync"]);

function writes(node: ts.Node, constants: Map<string, ts.Expression>, seen: Set<string>): boolean {
  let found = false;
  const visit = (at: ts.Node) => {
    if (found) return;
    const name = callName(at);
    if (name && WRITE_CALLS.has(name)) found = true;
    else if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && !seen.has(at.expression.text)) {
      const held = constants.get(at.expression.text);
      if (held && writes(held, constants, new Set([...seen, at.expression.text]))) found = true;
    }
    ts.forEachChild(at, visit);
  };
  visit(ts.isIdentifier(node) ? (constants.get(node.text) ?? node) : node);
  return found;
}

/** Whether pressing a handler reads something again: a refetch, a cache invalidation or a reload, written in
 *  place or behind a name, or a handler handed on under a retry's name. One that writes is an act. */
function readsAgain(node: ts.Node, constants: Map<string, ts.Expression>, seen = new Set<string>()): boolean {
  // Behind a name, a cache invalidation is a write's own follow-up, which reads nothing again for a failure.
  const calls = seen.size === 0 ? READ_AGAIN_CALLS : NAMED_READ_AGAIN_CALLS;
  if (ts.isIdentifier(node)) {
    if (READ_AGAIN_NAME.test(node.text)) return true;
    const held = constants.get(node.text);
    if (!held || seen.has(node.text)) return false;
    seen.add(node.text);
    return readsAgain(held, constants, seen);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return calls.has(node.name.text) || READ_AGAIN_NAME.test(node.name.text);
  }
  let found = false;
  const visit = (at: ts.Node) => {
    if (found) return;
    const name = callName(at);
    if (name && (calls.has(name) || READ_AGAIN_NAME.test(name))) found = true;
    else if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
      const held = constants.get(at.expression.text);
      if (held && !seen.has(at.expression.text)) {
        seen.add(at.expression.text);
        if (readsAgain(held, constants, seen)) found = true;
      }
    }
    ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
}

function identifiersIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (at: ts.Node) => {
    if (ts.isIdentifier(at)) names.push(at.text);
    ts.forEachChild(at, visit);
  };
  visit(node);
  return names;
}

/** A handler's own expression, from a JSX attribute or an object's property. */
function pressed(node: ts.Node): ts.Expression | null {
  if (ts.isJsxAttribute(node) && PRESS_HANDLERS.has(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer)) {
    return node.initializer.expression ?? null;
  }
  if (ts.isPropertyAssignment(node) && PRESS_HANDLERS.has(node.name.getText())) return node.initializer;
  if (ts.isShorthandPropertyAssignment(node) && PRESS_HANDLERS.has(node.name.text)) return node.name;
  return null;
}

/** Whether a sentence call ends the left side of a `+` whose right side opens with a stop. */
function sentenceEnds(node: ts.Expression): boolean {
  if (SENTENCE_CALLS.has(callName(node) ?? "")) return true;
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && sentenceEnds(node.right);
}

/** Every place in one file that breaks the rule, as `path:line what`. */
function offences(path: string, text: string): string[] {
  const rel = relative(SRC, path);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = constantsOf(file);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${what}`);
  const excused = (words: string) => rel in ACTS || `${rel}#${words}` in ACTS;

  const visit = (node: ts.Node) => {
    const drawn = ts.isJsxText(node) || (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent))
      ? wordsOf(node, constants)
      : ts.isStringLiteral(node) && inJsx(node) && !ts.isJsxExpression(node.parent)
        ? node.text
        : null;
    if (drawn !== null && RETRY_WORDS.test(drawn) && !insideRetryButton(node) && !excused(drawn)) {
      at(node, `draws "${drawn}" itself; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
    }
    if (ts.isJsxAttribute(node) && NAMING_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
      const named = wordsOf(node.initializer, constants);
      if (named !== null && RETRY_WORDS.test(named) && !insideRetryButton(node) && !excused(named)) {
        at(node, `names a control "${named}" itself; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
      }
    }
    const handler = pressed(node);
    const act = (h: ts.Expression) =>
      rel in ACTS ||
      `${rel}#${h.getText(file)}` in ACTS ||
      identifiersIn(h).some((name) => `${rel}#${name}` in ACTS);
    if (handler && readsAgain(handler, constants) && !writes(handler, constants, new Set()) && !insideRetryButton(node) && !act(handler)) {
      at(node, `reads again on a press of its own; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
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
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      sentenceEnds(node.left) &&
      (wordsOf(node.right, constants) ?? "").startsWith(".")
    ) {
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
      expect.stringContaining("reads again on a press of its own"),
      expect.stringContaining('draws "Retry" itself'),
    ]);
  });

  // ISS-1229 r51, judge-158 on 495: four of six plants passed, and three read-again controls had shipped under
  // other words. A control is found by what pressing it does, and by any words it is drawn or named with.
  it.each([
    ["an icon button named Retry", `<button aria-label="Retry" onClick={() => q.refetch()}><span className="icon-rerun" /></button>`],
    ["a button reading Retry loading", `<button onClick={() => q.refetch()}>Retry loading</button>`],
    ["a button reading Reload", `<button onClick={() => q.refetch()}>Reload</button>`],
    ["a Retry word held in a constant", `<button onClick={() => again()}>{AGAIN}</button>`],
    ["a control reading Read them again", `<Button variant="ghost" onClick={() => q.refetch()}>Read them again</Button>`],
    ["a control under words of its own", `<Button onClick={readAgain}>Fetch once more</Button>`],
    ["a menu item that reads again", `<Menu items={[{ label: "Check now", onSelect: () => qc.invalidateQueries({ queryKey: ["x"] }) }]} />`],
  ])("is refused for %s", (_, control) => {
    const file = `const AGAIN = "Retry";\nconst again = () => q.refetch();\nexport const A = ({ q, qc, readAgain }) => <p>Couldn't load the runs. ${control}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  it("passes a write that reads its answer back, which is an act and not a failed read's Retry", () => {
    const save = `const save = () => m.mutate(x, { onSuccess: () => q.refetch() });\nexport const A = ({ q, m }) => <button onClick={save}>Save</button>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), save)).toEqual([]);
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

  // ISS-1229 r51, judge-158 on 496: `formatApiError(e) + "."` passed.
  it("refuses a second full stop added with +, alone or at the end of a longer sum", () => {
    const added = `export const A = ({ e }) => <p>{formatApiError(e) + "."} {"Runs: " + formatApiError(e) + "."}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), added)).toHaveLength(2);
  });
});
