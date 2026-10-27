// ISS-1229 r50, judge-152 on criterion 478: most screens offered Retry on a 403, 404 or 422, each deciding for
// itself (an unconditional onRetry, or a second rule that allowed everything but a 401). One rule decides now —
// `isRetryableApiError`, through `RetryButton` and the error-state primitives — and this test walks every
// component in the web app and refuses a Retry for a failed read that does not go through it (criterion 495).
// It also refuses a failure sentence closed by a second full stop (criterion 496: "You do not have access to this..").
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
const READ_AGAIN_CALLS = new Set(["refetch", "refetchQueries", "invalidateQueries", "resetQueries", "reload", "refresh"]);

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
  "features/agents/components/questions-pane.tsx#() => router.refresh()":
    "loads the page again once the decision a run linked is no longer open: a read that answered, not one that failed",
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
    // A value taken under another name (`const { refetch: load } = useQuery(…)`) is still the value it was: the name
    // holds the one it was taken as, so `load()` reads again as `refetch()` does (ISS-1229 r52, judge-162).
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && ts.isIdentifier(node.name)) {
      found.set(node.name.text, node.propertyName);
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
  const calls = READ_AGAIN_CALLS;
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

/** Whether an expression is a sentence already closed: a sentence call, or a name holding one (ISS-1229 r52,
 *  judge-162: `const why = formatApiError(e)` then `{why}.` passed). */
function isSentence(node: ts.Expression, constants: Map<string, ts.Expression>, seen = new Set<string>()): boolean {
  if (SENTENCE_CALLS.has(callName(node) ?? "")) return true;
  if (ts.isParenthesizedExpression(node)) return isSentence(node.expression, constants, seen);
  if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
  const held = constants.get(node.text);
  return held !== undefined && isSentence(held, constants, new Set([...seen, node.text]));
}

/** Whether a sentence ends the left side of a `+` whose right side opens with a stop. */
function sentenceEnds(node: ts.Expression, constants: Map<string, ts.Expression>): boolean {
  if (isSentence(node, constants)) return true;
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && sentenceEnds(node.right, constants);
}

/** A component's own function, where its declaration is one this walk can read. */
type Definition = ts.FunctionLikeDeclaration;

/** The components a file defines, by name: a function declared, or one held in a constant, bare or wrapped once
 *  (`forwardRef(function …)`, `memo(() => …)`). */
function definitionsOf(file: ts.SourceFile): Map<string, Definition[]> {
  const found = new Map<string, Definition[]>();
  const add = (name: string, fn: Definition) => {
    if (/^[A-Z]/.test(name)) found.set(name, [...(found.get(name) ?? []), fn]);
  };
  const unwrap = (node: ts.Expression | undefined): Definition | null => {
    if (!node) return null;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    if (ts.isCallExpression(node)) return unwrap(node.arguments[0]);
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, node);
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) found.set("default", [node]);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fn = unwrap(node.initializer);
      if (fn) add(node.name.text, fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      found.set("default", found.get(statement.expression.text) ?? []);
    }
  }
  return found;
}

/** Every component the web source defines: by the file that defines it, and by name for a file this walk cannot place. */
interface Index {
  byFile: Map<string, Map<string, Definition[]>>;
  byName: Map<string, Definition[]>;
}

function indexOf(sources: readonly (readonly [path: string, text: string])[]): Index {
  const index: Index = { byFile: new Map(), byName: new Map() };
  for (const [path, text] of sources) {
    const defined = definitionsOf(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    index.byFile.set(path, defined);
    for (const [name, fns] of defined) {
      if (name !== "default") index.byName.set(name, [...(index.byName.get(name) ?? []), ...fns]);
    }
  }
  return index;
}

/** The names a file imports, by the name it uses: where from, and the name the other file exports it under. */
function importsOf(file: ts.SourceFile): Map<string, { from: string; name: string }> {
  const found = new Map<string, { from: string; name: string }>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) found.set(clause.name.text, { from, name: "default" });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) found.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
    }
  }
  return found;
}

/** A component as one file's JSX names it: its own, or an import under any name, read in the exporting file (r52 F1). */
function resolverFor(file: ts.SourceFile, elsewhere: Index): Resolver {
  const own = definitionsOf(file);
  const imports = importsOf(file);
  return (tag) => {
    const local = own.get(tag);
    if (local) return local;
    const imported = imports.get(tag);
    if (!imported) return elsewhere.byName.get(tag) ?? [];
    const there = filesFor(imported.from, file.fileName).map((f) => elsewhere.byFile.get(f)?.get(imported.name)).find((d) => d);
    return there ?? elsewhere.byName.get(imported.name) ?? [];
  };
}

type Resolver = (tag: string) => Definition[];

/** The files a module path written in `from` can name, where it is one of the web source's own. */
function filesFor(from: string, path: string): string[] {
  const base = from.startsWith("@/") ? join(SRC, from.slice(2)) : from.startsWith(".") ? join(dirname(path), from) : null;
  return base ? [`${base}.tsx`, join(base, "index.tsx")] : [];
}

/** The element a JSX attribute or spread is written on. */
function elementOf(attr: ts.JsxAttributeLike): ts.JsxOpeningLikeElement {
  return attr.parent.parent;
}

/** Whether an element is given an attribute of this name. */
function given(element: ts.JsxOpeningLikeElement, name: string): boolean {
  return element.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
}

/** Where a value handed to an element ends up there: the one Retry, pressed past it, or handed on to a component. */
type Landing = { kind: "rule" } | { kind: "pressed" } | { kind: "handed"; tag: string; prop: string } | { kind: "none" };

function landingOf(element: ts.JsxOpeningLikeElement, prop: string, at: ts.Node): Landing {
  const tag = tagName(element);
  if (insideRetryButton(at) || RETRY_PRIMITIVES.has(tag)) return { kind: "rule" };
  if (FAILURE_PRIMITIVES.has(tag) && given(element, "error")) return { kind: "rule" };
  if (PRESS_HANDLERS.has(prop)) return { kind: "pressed" };
  return /^[A-Z]/.test(tag) ? { kind: "handed", tag, prop } : { kind: "none" };
}

/**
 * Whether a component presses what it is handed as `prop` outside the one Retry: on a control of its own, through a
 * menu item, under a name of its own, or by handing it on to a component that does (ISS-1229 r52, judge-162:
 * `<FailNote actionLabel="Retry" onAction={() => q.refetch()} />` passed, FailNote drawing `<a onClick={onAction}>`).
 */
function pressesProp(
  tag: string,
  prop: string,
  definitions: Resolver,
  elsewhere: Index,
  depth = 0,
  seen = new Set<string>(),
): boolean {
  const key = `${tag}.${prop}`;
  if (depth > 4 || seen.has(key)) return false;
  seen.add(key);
  return definitions(tag).some((fn) => {
    if (relative(SRC, fn.getSourceFile().fileName) in ACTS) return false;
    const param = fn.parameters[0]?.name;
    if (!param || !fn.body) return false;
    const names = new Set<string>();
    let whole: string | null = null;
    let rest: string | null = null;
    if (ts.isObjectBindingPattern(param)) {
      for (const el of param.elements) {
        const key = (el.propertyName ?? el.name).getText();
        if (el.dotDotDotToken && ts.isIdentifier(el.name)) rest = el.name.text;
        else if (key === prop && ts.isIdentifier(el.name)) names.add(el.name.text);
      }
    } else if (ts.isIdentifier(param)) {
      whole = param.text;
    }
    const lands = (landing: Landing) =>
      landing.kind === "pressed" ||
      (landing.kind === "handed" &&
        pressesProp(landing.tag, landing.prop, resolverFor(fn.getSourceFile(), elsewhere), elsewhere, depth + 1, seen));
    let pressed = false;
    const reached = (node: ts.Node): boolean =>
      (ts.isIdentifier(node) && names.has(node.text) && !ts.isBindingElement(node.parent)) ||
      (whole !== null && ts.isPropertyAccessExpression(node) && node.expression.getText() === whole && node.name.text === prop);
    const follow = (use: ts.Node) => {
      for (let at: ts.Node = use.parent; at && at !== fn; at = at.parent) {
        if (ts.isJsxAttribute(at)) {
          if (lands(landingOf(elementOf(at), at.name.getText(), at))) pressed = true;
          return;
        }
        if (ts.isPropertyAssignment(at) || ts.isShorthandPropertyAssignment(at)) {
          if (PRESS_HANDLERS.has(at.name.getText()) && !insideRetryButton(at)) pressed = true;
          return;
        }
        if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) {
          names.add(at.name.text);
          return;
        }
      }
    };
    // A name taken for it is followed as it is: run until no use adds a name.
    for (let size = -1; size !== names.size && !pressed; ) {
      size = names.size;
      const visit = (node: ts.Node) => {
        if (pressed) return;
        if (reached(node)) follow(node);
        if (ts.isJsxSpreadAttribute(node) && [rest, whole].includes(node.expression.getText())) {
          if (lands(landingOf(elementOf(node), prop, node))) pressed = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(fn.body);
    }
    return pressed;
  });
}

/** Every place in one file that breaks the rule, as `path:line what`. */
function offences(path: string, text: string, elsewhere: Index = { byFile: new Map(), byName: new Map() }): string[] {
  const rel = relative(SRC, path);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = constantsOf(file);
  const definitions = resolverFor(file, elsewhere);
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
    const handed =
      ts.isJsxAttribute(node) && !PRESS_HANDLERS.has(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : undefined;
    if (ts.isJsxAttribute(node) && handed && readsAgain(handed, constants) && !writes(handed, constants, new Set()) && !act(handed)) {
      const landing = landingOf(elementOf(node), node.name.getText(), node);
      if (landing.kind === "handed" && !FAILURE_PRIMITIVES.has(landing.tag) && pressesProp(landing.tag, landing.prop, definitions, elsewhere)) {
        at(node, `hands a read-again to <${landing.tag}> as ${landing.prop}, which presses it outside RetryButton, the one rule`);
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const attrs = node.attributes.properties;
      const named = (n: string) => attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText() === n);
      if (FAILURE_PRIMITIVES.has(name) && named("onRetry") && !named("error")) {
        at(node, `<${name}> is given onRetry without the failed read's error`);
      }
    }
    if (ts.isTemplateSpan(node) && isSentence(node.expression, constants) && node.literal.text.startsWith(".")) {
      at(node, "closes a sentence that already ends with its own stop");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      sentenceEnds(node.left, constants) &&
      (wordsOf(node.right, constants) ?? "").startsWith(".")
    ) {
      at(node, "closes a sentence that already ends with its own stop");
    }
    if (ts.isJsxExpression(node) && node.expression && isSentence(node.expression, constants)) {
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
    const sources = components(SRC).map((path) => [path, readFileSync(path, "utf8")] as const);
    const elsewhere = indexOf(sources);
    const all = sources.flatMap(([path, text]) => offences(path, text, elsewhere));
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
    ["a named handler that invalidates a read", `<button onClick={refresh}>Check now</button>`],
  ])("is refused for %s", (_, control) => {
    const file = `const AGAIN = "Retry";\nconst again = () => q.refetch();\nconst refresh = () => qc.invalidateQueries({ queryKey: ["x"] });\nexport const A = ({ q, qc, readAgain }) => <p>Couldn't load the runs. ${control}</p>;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  // ISS-1229 r52, judge-162 on 495: a refetch taken under another name, the shape three shipped files use, and a
  // Retry handed through props to a part that presses it, each passed. A read-again is followed by what it is.
  it.each([
    [
      "a refetch taken under another name and pressed",
      `const { isError, refetch: load } = useQuery({ queryKey: ["runs"] });\nexport const A = () => (isError ? <p>Couldn't load the runs. <button onClick={() => load()}>Load them</button></p> : null);`,
    ],
    [
      "a Retry handed through props to a part that presses it",
      `function FailNote({ text, actionLabel, onAction }) { return <p>{text} <a href="#" onClick={onAction}>{actionLabel}</a></p>; }\nexport const A = ({ q }) => <FailNote text="Couldn't load the runs." actionLabel="Retry" onAction={() => q.refetch()} />;`,
    ],
    [
      "a renamed refetch handed through props",
      `const { refetch: load } = useQuery({ queryKey: ["runs"] });\nfunction FailNote({ onAction }) { return <button onClick={() => onAction()}>Again</button>; }\nexport const A = () => <FailNote onAction={load} />;`,
    ],
    [
      "a Retry handed on twice before it is pressed",
      `function Press({ go }) { return <button onClick={go}>Go</button>; }\nfunction FailNote({ onAction }) { const then = () => onAction(); return <Press go={then} />; }\nexport const A = ({ q }) => <FailNote onAction={() => q.refetch()} />;`,
    ],
    [
      "a Retry handed through props spread onto a button",
      `function FailNote({ text, ...rest }) { return <p>{text}<button {...rest}>Again</button></p>; }\nexport const A = ({ q }) => <FailNote text="x" onClick={() => q.refetch()} />;`,
    ],
    ["a router refresh pressed", `export const A = ({ router }) => <p>Couldn't load the runs. <button onClick={() => router.refresh()}>Refresh</button></p>;`],
  ])("is refused for %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file).length).toBeGreaterThan(0);
  });

  it.each([
    ["under another name", `import { FailNote as Notice } from "./fail-note";`, "Notice"],
    ["as its file's default", `import Notice from "@/features/x/fail-note";`, "Notice"],
  ])("is refused for a Retry handed to a part imported %s, which presses it", (_, imported, tag) => {
    const note = join(SRC, "features/x/fail-note.tsx");
    const elsewhere = indexOf([
      [note, `export function FailNote({ onAction }) { return <button onClick={onAction}>Load</button>; }\nexport default FailNote;`],
      [join(SRC, "features/y/fail-note.tsx"), `export function FailNote({ onAction }) { return <RetryButton error={null} onRetry={onAction} />; }`],
    ]);
    const file = `${imported}\nexport const A = ({ q }) => <${tag} onAction={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/x/a.tsx"), file, elsewhere)).toEqual([
      expect.stringContaining(`hands a read-again to <${tag}> as onAction`),
    ]);
  });

  // r52 review F1 (second read): a part handing the Retry on resolves the next part by its own file's imports.
  it("is refused for a Retry an imported part hands on to a part it imports under another name", () => {
    const elsewhere = indexOf([
      [join(SRC, "features/x/press.tsx"), `export function Press({ go }) { return <button onClick={go}>Load</button>; }`],
      [
        join(SRC, "features/x/notice.tsx"),
        `import { Press as Trigger } from "./press";\nexport function Notice({ onAction }) { return <Trigger go={onAction} />; }`,
      ],
    ]);
    const file = `import { Notice } from "@/features/x/notice";\nexport const A = ({ q }) => <Notice onAction={() => q.refetch()} />;`;
    expect(offences(join(SRC, "features/y/a.tsx"), file, elsewhere)).toEqual([
      expect.stringContaining("hands a read-again to <Notice> as onAction"),
    ]);
  });

  it.each([
    [
      "a renamed refetch given to RetryButton",
      `const { error, refetch: load } = useQuery({ queryKey: ["runs"] });\nexport const A = () => <RetryButton error={error} onRetry={load} />;`,
    ],
    [
      "a Retry handed to a part that gives it to RetryButton",
      `function FailNote({ error, onAction }) { return <RetryButton error={error} onRetry={onAction} />; }\nexport const A = ({ q }) => <FailNote error={q.error} onAction={() => q.refetch()} />;`,
    ],
    [
      "a Retry handed to an error state with the read's error",
      `export const A = ({ q }) => <ErrorState title="Couldn't load" error={q.error} onRetry={() => q.refetch()} />;`,
    ],
  ])("passes %s", (_, file) => {
    expect(offences(join(SRC, "features/x/a.tsx"), file)).toEqual([]);
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

  // ISS-1229 r52, judge-162 on 496: a sentence held in a name first, then given its own stop, passed.
  it("refuses a second full stop after a sentence held in a name, in JSX, in a template and with +", () => {
    const held =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
      "export function A({ e }) { const why = formatApiError(e); const told = why; return <p title={`Runs: ${why}.`}>Runs: {why}. {told + \".\"}</p>; }";
    expect(offences(join(SRC, "features/x/a.tsx"), held)).toHaveLength(3);
  });

  it("passes a held sentence closed by withStop, which adds a stop only where none stands", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source text under test, not a template meant to interpolate
    const closed = "export function A({ e }) { const why = formatApiError(e); return <p>{`${withStop(why)} Save again.`}</p>; }";
    expect(offences(join(SRC, "features/x/a.tsx"), closed)).toEqual([]);
  });
});
