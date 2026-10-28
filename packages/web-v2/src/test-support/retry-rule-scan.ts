// The reading behind retry-rule-source.test.ts (criteria 478, 479, 495, 496). A failed read's state is found by its
// words, the parts that draw one, or the branch a read's failure guards; every press inside it must resolve to the
// one Retry rule, a write, a move to another page or a change to what the page shows. A press it cannot resolve is
// refused: the reading names what it recognises, never a list of the ways a read can be made again (ISS-1229 r53).
//
// What one file's static reading still cannot see: a handler reached only at run time (a function picked from a map
// by a key, a component picked by a variable tag, a prop handed down through React context), a package's own
// component pressing what it is handed, and a failure said in words FAILURE_WORDS does not hold with no guard naming
// it. Each is read as far as its source goes and no further.
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export const SRC = join(__dirname, "..");

/** The words a control that reads something again is drawn with, as its text, its accessible name or its title. */
const RETRY_WORDS = /^(Retry\b.*|Retrying…|Try again\b.*|Reload\b.*|Read (it |them )?again\b.*)$/;

/** Words saying a read failed: with the parts that draw one, what marks a state as a failed read's. */
const FAILURE_WORDS = /\b(?:couldn['’]t|could not|can['’]t|cannot|unable to|failed to|did not|didn['’]t) (?:load|read|reach|fetch|get)\b|\bnot loaded\b/i;

/** A guard naming a failure: the branch it opens is a failed read's state. */
const FAILURE_GUARD = /^(?:is)?(?:error|errored|failed|failure|unread|readFailed|loadFailed)$/i;

const NAMING_ATTRIBUTES = new Set(["aria-label", "title", "label"]);

/** A press: any handler a person sets off, a form's submit included. */
const PRESS = /^on[A-Z]/;

/** An item's own press, a toast's or a menu entry's: an object's other `on…` members are handed on, not pressed. */
const ITEM_PRESS = /^on(Click|Select|Press|Activate|Action|PointerUp|PointerDown|MouseDown|MouseUp|KeyDown|KeyUp|Submit)$/;

/** Handlers that follow the pointer, the focus or the page without a person pressing anything. */
const NOT_A_PRESS = new Set(["onSuccess", "onSettled", "onMutate", "onMouseEnter", "onMouseLeave", "onPointerEnter", "onPointerLeave", "onFocus", "onBlur", "onScroll", "onLoad", "onError", "onAnimationEnd", "onTransitionEnd"]);

const READ_AGAIN_CALLS = new Set(["refetch", "refetchQueries", "invalidateQueries", "resetQueries", "reload", "refresh", "fetchQuery", "prefetchQuery", "ensureQueryData"]);
const READ_AGAIN_NAME = /^(on)?(retry|refetch|reload|reread|readagain)/i;
const WRITE_CALLS = new Set(["mutate", "mutateAsync"]);

/** Calls that change what this page shows, or where focus is, and read nothing. */
const INERT_METHODS = new Set([
  "preventDefault", "stopPropagation", "focus", "blur", "select", "scrollIntoView", "scrollTo", "setPointerCapture", "releasePointerCapture",
  "writeText", "close", "showModal", "toggle", "add", "delete", "set", "clear", "reset", "get", "has",
  // A value's own computation: the language's methods on strings, arrays, numbers and dates read nothing.
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "slice", "substring", "trim", "toLowerCase", "toUpperCase", "split", "join", "replace",
  "replaceAll", "match", "test", "map", "filter", "find", "findIndex", "some", "every", "reduce", "flatMap", "concat", "at", "keys", "values", "entries",
  "toString", "toFixed", "toISOString", "getTime", "padStart", "localeCompare", "sort", "reverse", "push", "pop", "shift", "unshift", "splice",
  // The page's own document and form: finding, measuring and wiring elements, and a form's values, read no server.
  "closest", "querySelector", "querySelectorAll", "getAttribute", "contains", "matches", "getBoundingClientRect", "addEventListener", "removeEventListener",
  "getValues", "trigger", "watch", "clearErrors", "resetField", "getItem", "removeItem", "click", "getElementById", "dispatchEvent", "forEach",
  "createElement", "appendChild", "submit", "json", "text", "blob", "charAt", "charCodeAt", "trimStart", "trimEnd", "repeat", "normalize",
]);
/** Hooks whose setters change what this page shows. */
const STATE_HOOKS = new Set(["useState", "useReducer", "useTransition", "useOptimistic"]);
/** Calls that run the function they are given: it is judged as the press. */
const WRAPPERS = new Set(["handleSubmit", "startTransition", "setTimeout", "requestAnimationFrame", "queueMicrotask", "flushSync"]);
/** A chain after a promise: judged by what it chains from, then by what it runs. */
const CHAINS = new Set(["then", "catch", "finally"]);
/** The language's own namespaces: a call on one computes a value and reads nothing. */
const INERT_OWNERS = /^(Math|JSON|Object|Array|Number|String|Date|console|Promise|URLSearchParams)$/;
const INERT_CALLS = new Set(["toast", "dismiss", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "String", "Number", "Boolean", "encodeURIComponent"]);
/** Method names a server client answers to as well as a collection: inert only where the receiver is shown to be one. */
const CLIENT_SHAPED = new Set(["get", "delete", "set", "add", "has", "clear"]);
/** The language's and the page's own collections, whose `get` or `delete` reads no server. */
const COLLECTIONS = /^new\s+(Map|Set|WeakMap|WeakSet|URLSearchParams|FormData|Headers)\b/;
/** A move elsewhere: pressing it leaves for another page, which is not this one read again. */
const NAVIGATION_METHODS = new Set(["push", "replace", "back", "forward", "open", "prefetch", "pushState", "replaceState"]);

/**
 * Files whose Retry repeats an act rather than a read, so no read's error decides it: each is named with
 * the act, as a whole file or as `file#words` where the same file also reads. Adding one here says, in
 * review, that its Retry is not a failed read's.
 */
export const ACTS: Record<string, string> = {
  "design/primitives/retry-button.tsx": "the one Retry itself",
  "design/primitives/retry-link.tsx": "the one Retry itself, as a word",
  "design/primitives/retry-wait.tsx": "the one Retry's wait",
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

const RETRY_PRIMITIVES = new Set(["RetryButton", "RetryLink"]);
const FAILURE_PRIMITIVES = new Set(["ErrorState", "ReadFailedLine", "StaleReadLine"]);
const SENTENCE_CALLS = new Set(["formatApiError", "formatApiReason", "couldNotRead", "couldNotReadAll"]);

/** Roles a screen reader announces as they change; a timer is read only when asked. */
const LIVE_ROLES = new Set(["alert", "status", "log", "marquee"]);

type Definition = ts.FunctionLikeDeclaration;

interface Source {
  path: string;
  file: ts.SourceFile;
  constants: Map<string, ts.Node>;
  definitions: Map<string, Definition[]>;
  imports: Map<string, { from: string; name: string }>;
}

/** Every file the web source holds, read once: what each defines and imports, where each component is drawn, and
 *  which components draw the one Retry's wait. */
export interface Index {
  files: Map<string, Source>;
  byName: Map<string, Definition[]>;
  uses: Map<Definition, { element: ts.JsxOpeningLikeElement; source: Source }[]>;
  gates: Set<Definition>;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function elementOf(attr: ts.JsxAttributeLike): ts.JsxOpeningLikeElement {
  return attr.parent.parent;
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
}

function attributeValue(attr: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const init = attr?.initializer;
  if (!init) return undefined;
  return ts.isJsxExpression(init) ? init.expression : init;
}

function callName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function where(node: ts.Node): string {
  const file = node.getSourceFile();
  return `${relative(SRC, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

/** The names a file declares, by name: a constant, a function, or a value taken under another name. */
function constantsOf(file: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) found.set(node.name.text, node.initializer);
    // `const { refetch: load } = useQuery(…)`: the name holds the one it was taken as, so `load()` reads as `refetch()`.
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && ts.isIdentifier(node.name)) {
      found.set(node.name.text, node.propertyName);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && !found.has(node.name.text)) {
      found.set(node.name.text, node);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) found.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function wordsOf(node: ts.Node, constants: Map<string, ts.Node>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isJsxText(node)) return node.text.trim();
  if (ts.isJsxExpression(node) && node.expression) return wordsOf(node.expression, constants);
  if (ts.isParenthesizedExpression(node)) return wordsOf(node.expression, constants);
  if (ts.isIdentifier(node)) {
    const held = constants.get(node.text);
    return held && (ts.isStringLiteral(held) || ts.isNoSubstitutionTemplateLiteral(held)) ? held.text : null;
  }
  return null;
}

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

function importsOf(file: ts.SourceFile): Map<string, { from: string; name: string }> {
  const found = new Map<string, { from: string; name: string }>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) found.set(clause.name.text, { from, name: "default" });
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) found.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
    }
    if (bindings && ts.isNamespaceImport(bindings)) found.set(bindings.name.text, { from, name: "*" });
  }
  return found;
}

/** The files a module path can name, where it is one of the web source's own: a file, or a folder's index. */
function filesFor(from: string, path: string, index: Index): string[] {
  const base = from.startsWith("@/") ? join(SRC, from.slice(2)) : from.startsWith(".") ? join(dirname(path), from) : null;
  if (!base) return [];
  return [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")].filter((f) => index.files.has(f));
}

/** What a file exports under a name, followed through re-exports under any name and `export *`. */
function exportedFrom<T>(path: string, name: string, index: Index, own: (s: Source, n: string) => T | undefined, seen = new Set<string>()): T | undefined {
  const key = `${path}#${name}`;
  const source = index.files.get(path);
  if (!source || seen.has(key)) return undefined;
  seen.add(key);
  const here = own(source, name);
  if (here !== undefined) return here;
  for (const statement of source.file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    const clause = statement.exportClause;
    const names =
      clause && ts.isNamedExports(clause)
        ? clause.elements.filter((el) => el.name.text === name).map((el) => (el.propertyName ?? el.name).text)
        : !clause
          ? [name]
          : [];
    for (const inner of names) {
      if (!from) return own(source, inner);
      for (const f of filesFor(from, path, index)) {
        const found = exportedFrom(f, inner, index, own, seen);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

const ownDefinitions = (s: Source, n: string) => s.definitions.get(n);
const ownValue = (s: Source, n: string) => s.constants.get(n);

/** A component as one file's JSX names it: its own, or an import under any name, through barrels; by name only where
 *  the import names none of the web source's files. */
function resolve(source: Source, tag: string, index: Index): Definition[] {
  const local = source.definitions.get(tag);
  if (local) return local;
  const [head, member] = tag.split(".");
  const imported = head ? source.imports.get(head) : undefined;
  if (!imported) return index.byName.get(tag) ?? [];
  const name = imported.name === "*" && member ? member : imported.name;
  for (const f of filesFor(imported.from, source.path, index)) {
    const found = exportedFrom(f, name, index, ownDefinitions);
    if (found) return found;
  }
  return index.byName.get(name) ?? [];
}

/** A value a file imports, where the web source defines it: the function behind a helper's name. */
function importedValue(source: Source, name: string, index: Index): { node: ts.Node; source: Source } | undefined {
  const imported = source.imports.get(name);
  if (!imported || imported.name === "*") return undefined;
  for (const f of filesFor(imported.from, source.path, index)) {
    const node = exportedFrom(f, imported.name, index, ownValue);
    const there = node && index.files.get(node.getSourceFile().fileName);
    if (node && there) return { node, source: there };
  }
  return undefined;
}

export function indexOf(sources: readonly (readonly [path: string, text: string])[]): Index {
  const index: Index = { files: new Map(), byName: new Map(), uses: new Map(), gates: new Set() };
  for (const [path, text] of sources) {
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const source: Source = { path, file, constants: constantsOf(file), definitions: definitionsOf(file), imports: importsOf(file) };
    index.files.set(path, source);
    for (const [name, fns] of source.definitions) {
      if (name !== "default") index.byName.set(name, [...(index.byName.get(name) ?? []), ...fns]);
    }
  }
  for (const source of index.files.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        for (const def of resolve(source, tagName(node), index)) index.uses.set(def, [...(index.uses.get(def) ?? []), { element: node, source }]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source.file);
  }
  index.gates = gatesOf(index);
  return index;
}

/** The components that draw the one Retry's wait: its gate, and every part that renders one, to a fixed point. */
function gatesOf(index: Index): Set<Definition> {
  const gates = new Set<Definition>(index.byName.get("RetryWaitGate") ?? []);
  for (let size = -1; size !== gates.size; ) {
    size = gates.size;
    for (const source of index.files.values()) {
      for (const fns of source.definitions.values()) {
        for (const fn of fns) {
          if (gates.has(fn) || !fn.body) continue;
          let draws = false;
          const visit = (node: ts.Node) => {
            if (draws) return;
            if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && resolve(source, tagName(node), index).some((d) => gates.has(d))) draws = true;
            ts.forEachChild(node, visit);
          };
          visit(fn.body);
          if (draws) gates.add(fn);
        }
      }
    }
  }
  return gates;
}

/** The component a node is written in, where it is one this file defines. */
function enclosingComponent(node: ts.Node, source: Source): Definition | undefined {
  const all = new Set([...source.definitions.values()].flat());
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (all.has(at as Definition)) return at as Definition;
  }
  return undefined;
}

/** The names a component's props are taken under, `{ onClose, onRetry: retry }`, or the whole `props`. */
function propNames(fn: Definition): { names: Map<string, string>; whole: string | null; rest: string | null } {
  const names = new Map<string, string>();
  let whole: string | null = null;
  let rest: string | null = null;
  const param = fn.parameters[0]?.name;
  if (param && ts.isObjectBindingPattern(param)) {
    for (const el of param.elements) {
      if (el.dotDotDotToken && ts.isIdentifier(el.name)) rest = el.name.text;
      else if (ts.isIdentifier(el.name)) names.set(el.name.text, (el.propertyName ?? el.name).getText());
    }
  } else if (param && ts.isIdentifier(param)) {
    whole = param.text;
  }
  return { names, whole, rest };
}

function insideRetryButton(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isJsxElement(at) && RETRY_PRIMITIVES.has(tagName(at.openingElement))) return true;
    if (ts.isJsxSelfClosingElement(at) && RETRY_PRIMITIVES.has(tagName(at))) return true;
  }
  return false;
}

/** What pressing a handler does, as far as the source says: recognised, or refused with why. */
type Verdict = { ok: true } | { ok: false; why: string };
const OK: Verdict = { ok: true };
const refused = (why: string): Verdict => ({ ok: false, why });

interface Reading {
  index: Index;
  depth: number;
  seen: Set<ts.Node>;
}

const deeper = (reading: Reading): Reading => ({ ...reading, depth: reading.depth + 1 });

type Held = { node: ts.Node; source: Source };

/** An object literal's member by name. */
function memberOf(object: ts.ObjectLiteralExpression, key: string, source: Source): Held | null {
  for (const p of object.properties) {
    if (p.name?.getText() !== key) continue;
    if (ts.isPropertyAssignment(p)) return { node: p.initializer, source };
    if (ts.isMethodDeclaration(p)) return { node: p, source };
    if (ts.isShorthandPropertyAssignment(p)) return { node: p.name, source };
  }
  return null;
}

/** What a hook hands back under `key` (a member's name, or a place in a tuple): every value its body can return
 *  there, read in the hook's own file. */
function hookReturns(call: ts.Expression, key: string | number, source: Source, index: Index): Held[] | null {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  const local = declared(call.expression);
  const hook = local && local !== PARAMETER ? { node: local, source } : importedValue(source, call.expression.text, index);
  const fn = hook?.node;
  if (!hook || !fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.body) return null;
  const found: Held[] = [];
  const take = (value: ts.Node | undefined): void => {
    if (!value) return;
    if (ts.isParenthesizedExpression(value)) {
      take(value.expression);
      return;
    }
    if (ts.isConditionalExpression(value)) {
      take(value.whenTrue);
      take(value.whenFalse);
      return;
    }
    if (typeof key === "string" && ts.isObjectLiteralExpression(value)) {
      const member = memberOf(value, key, hook.source);
      if (member) found.push(member);
    }
    if (typeof key === "number" && ts.isArrayLiteralExpression(value) && value.elements[key]) found.push({ node: value.elements[key], source: hook.source });
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node)) take(node.expression);
    ts.forEachChild(node, visit);
  };
  if (ts.isBlock(fn.body)) visit(fn.body);
  else take(fn.body);
  return found.length ? found : null;
}

/** Stands for a name that is a function's parameter: what it holds is whatever the caller hands in. */
const PARAMETER = ts.factory.createIdentifier("parameter");

/** Where a name is declared, scope by scope outward from where it is used: a constant's value, a destructured binding,
 *  a function, or a parameter. */
function declared(node: ts.Identifier): ts.Node | undefined {
  const name = node.text;
  const inPattern = (pattern: ts.BindingName): ts.BindingElement | undefined => {
    if (ts.isIdentifier(pattern)) return undefined;
    for (const el of pattern.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isIdentifier(el.name) && el.name.text === name) return el;
      const deeper = inPattern(el.name);
      if (deeper) return deeper;
    }
    return undefined;
  };
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      for (const p of at.parameters) {
        if ((ts.isIdentifier(p.name) && p.name.text === name) || inPattern(p.name)) return PARAMETER;
      }
    }
    const statements = ts.isBlock(at) || ts.isSourceFile(at) || ts.isModuleBlock(at) ? at.statements : null;
    for (const statement of statements ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer;
        const el = inPattern(decl.name);
        // `const { refetch: load } = useQuery(…)`: the name holds the one it was taken as.
        if (el) return el.propertyName && ts.isIdentifier(el.propertyName) && ts.isObjectBindingPattern(el.parent) && !ts.isVariableDeclaration(el.parent.parent) ? el.propertyName : el;
      }
    }
  }
  return undefined;
}

/** What a destructured name holds: a state hook's setter, or what the hook it came from returns under that name. */
function bindingValues(el: ts.BindingElement, source: Source, index: Index): Held[] | null {
  const declaration = el.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
  if (ts.isArrayBindingPattern(el.parent)) {
    // `const [open, toggle] = useState(…)`: what a state hook hands back changes what the page shows.
    if (STATE_HOOKS.has(callName(declaration.initializer) ?? "")) return [{ node: ts.factory.createNull(), source }];
    return hookReturns(declaration.initializer, el.parent.elements.indexOf(el), source, index);
  }
  const key = (el.propertyName ?? el.name).getText();
  if (ts.isIdentifier(declaration.initializer)) return heldValues(ts.factory.createPropertyAccessExpression(declaration.initializer, key), source, index, declaration.initializer);
  return hookReturns(declaration.initializer, key, source, index);
}

/** The values a name can hold: a constant, an object's member, an imported helper, a hook's return. */
function heldValues(node: ts.Expression, source: Source, index: Index, at: ts.Node = node): Held[] | null {
  if (ts.isIdentifier(node)) {
    const held = declared(node.parent ? node : (at as ts.Identifier));
    if (held === PARAMETER) return null;
    if (held && ts.isBindingElement(held)) return bindingValues(held, source, index);
    if (held) return [{ node: held, source }];
    // A pure helper from the shared contracts package computes a value; it has no client to read with.
    if (source.imports.get(node.text)?.from.startsWith("@forge/contracts")) return [{ node: ts.factory.createNull(), source }];
    const imported = importedValue(source, node.text, index);
    return imported ? [imported] : null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const anchor = node.expression.parent ? node.expression : (at as ts.Identifier);
    const owner = declared(anchor);
    if (owner && owner !== PARAMETER && ts.isObjectLiteralExpression(owner)) {
      const member = memberOf(owner, node.name.text, source);
      return member ? [member] : null;
    }
    if (owner && owner !== PARAMETER && ts.isCallExpression(owner)) return hookReturns(owner, node.name.text, source, index);
  }
  return null;
}

/**
 * Whether pressing `handler` is one of what this reading recognises: the one Retry, a write, a move to another page,
 * or a change to what this page shows. Anything else, a read made again by any means included, is refused.
 */
function pressVerdict(handler: ts.Node, source: Source, reading: Reading): Verdict {
  if (reading.seen.has(handler) || reading.depth > 8) return OK;
  reading.seen.add(handler);
  const next = deeper(reading);
  if (ts.isParenthesizedExpression(handler) || ts.isAsExpression(handler) || ts.isNonNullExpression(handler)) return pressVerdict(handler.expression, source, next);
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler) || ts.isFunctionDeclaration(handler) || ts.isMethodDeclaration(handler)) {
    return handler.body ? bodyVerdict(handler.body, source, next) : OK;
  }
  if (ts.isCallExpression(handler)) {
    // `useCallback(fn, deps)` holds the function it is given.
    if (callName(handler) === "useCallback" && handler.arguments[0]) return pressVerdict(handler.arguments[0], source, next);
    return callVerdict(handler, source, next);
  }
  if (ts.isIdentifier(handler) && (handler.text === "undefined" || /^set[A-Z]/.test(handler.text))) return OK;
  if (ts.isIdentifier(handler) || ts.isPropertyAccessExpression(handler)) {
    const name = ts.isIdentifier(handler) ? handler.text : handler.name.text;
    if (READ_AGAIN_CALLS.has(name)) return refused(`${handler.getText()} reads again`);
    const prop = propCall(handler, source);
    if (prop) return propVerdict(prop.fn, prop.name, next);
    // A callback's own parameter is what its caller hands it, and that is judged where the call is written.
    if (ts.isIdentifier(handler) && declared(handler) === PARAMETER) return OK;
    const held = heldValues(handler, source, reading.index);
    for (const value of held ?? []) {
      const verdict = pressVerdict(value.node, value.source, next);
      if (!verdict.ok) return verdict;
    }
    return held ? OK : refused(`${handler.getText()} is not one this reading can follow`);
  }
  if (ts.isConditionalExpression(handler)) {
    const either = pressVerdict(handler.whenTrue, source, next);
    return either.ok ? pressVerdict(handler.whenFalse, source, next) : either;
  }
  if (handler.kind === ts.SyntaxKind.NullKeyword || handler.kind === ts.SyntaxKind.FalseKeyword) return OK;
  if (ts.isBinaryExpression(handler)) return pressVerdict(handler.right, source, next);
  return refused(`${handler.getText().slice(0, 60)} is not one this reading can follow`);
}

function bodyVerdict(body: ts.Node, source: Source, reading: Reading): Verdict {
  if (writesAnywhere(body)) return OK;
  let verdict: Verdict = OK;
  const visit = (node: ts.Node) => {
    if (!verdict.ok) return;
    if (ts.isCallExpression(node)) {
      verdict = callVerdict(node, source, reading);
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return verdict;
}

/** The arguments a call is given, each judged as a press would be where it runs: the functions it is handed, and the
 *  values worked out for it. */
function argumentsVerdict(call: ts.CallExpression, source: Source, reading: Reading): Verdict {
  for (const arg of call.arguments) {
    const verdict = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg) ? pressVerdict(arg, source, reading) : bodyVerdict(arg, source, reading);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

/** Whether a handler's body makes a write anywhere: it is an act, whatever it reads back after. */
function writesAnywhere(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && isWrite(node)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Whether a call, or the chain it ends, makes a write: what it reads back after is the write's. */
function chainWrites(call: ts.CallExpression): boolean {
  if (isWrite(call)) return true;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression) && chainWrites(callee.expression);
}

/** A write is an act whatever it reads back after; `apiClient` with no method is a read. */
function isWrite(call: ts.CallExpression): boolean {
  if (WRITE_CALLS.has(callName(call) ?? "")) return true;
  if (callName(call) !== "apiClient" && callName(call) !== "fetch") return false;
  const options = call.arguments[1];
  return !!options && ts.isObjectLiteralExpression(options) &&
    options.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "method" && !/GET|HEAD/.test(p.initializer.getText()));
}

function callVerdict(call: ts.CallExpression, source: Source, reading: Reading): Verdict {
  const callee = call.expression;
  const name = callName(call);
  if (chainWrites(call)) return OK;
  if (name && READ_AGAIN_CALLS.has(name)) return refused(`${callee.getText()}() reads again`);
  const then = (verdict: Verdict): Verdict => (verdict.ok ? argumentsVerdict(call, source, reading) : verdict);
  if (ts.isIdentifier(callee)) {
    if (/^set[A-Z]/.test(callee.text) || INERT_CALLS.has(callee.text) || WRAPPERS.has(callee.text)) return then(OK);
    if (callee.text === "apiClient" || callee.text === "fetch") return refused(`${callee.text}() makes a read of its own`);
    return then(pressVerdict(callee, source, reading));
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const owner = callee.expression;
    const method = callee.name.text;
    if (/(^|\.)location$/.test(owner.getText())) return refused(`${owner.getText()}.${method}() loads the page again`);
    const ownerVerdict = ts.isCallExpression(owner) ? callVerdict(owner, source, reading) : OK;
    if (!ownerVerdict.ok) return ownerVerdict;
    if (CLIENT_SHAPED.has(method) && !INERT_OWNERS.test(owner.getText()) && !isCollection(owner)) {
      return refused(`${owner.getText().slice(0, 40)}.${method}() may be a server client's, and its receiver is not shown to be a collection`);
    }
    const recognised =
      INERT_METHODS.has(method) || /^set[A-Z]/.test(method) || WRAPPERS.has(method) || CHAINS.has(method) || INERT_OWNERS.test(owner.getText()) ||
      (NAVIGATION_METHODS.has(method) && /router|window|history/i.test(owner.getText()));
    return then(recognised || ts.isCallExpression(owner) ? OK : pressVerdict(callee, source, reading));
  }
  // `handleSubmit(fn)()`: the function a wrapper hands back runs what it was given.
  if (ts.isCallExpression(callee)) return then(callVerdict(callee, source, reading));
  if (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) return then(pressVerdict(callee.expression, source, reading));
  return refused(`${callee.getText().slice(0, 60)}() is not one this reading can follow`);
}

/** Whether a receiver is a collection the page holds: declared as `new Map()` and its kin, a ref's current one, or
 *  the address's search parameters. Anything else named `get` or `delete` may be a client's. */
function isCollection(owner: ts.Expression): boolean {
  if (/(^|\.)(searchParams|classList|dataset)$/.test(owner.getText())) return true;
  const root = ts.isPropertyAccessExpression(owner) && owner.name.text === "current" ? owner.expression : owner;
  if (!ts.isIdentifier(root)) return false;
  const value = declared(root);
  if (!value || value === PARAMETER) return false;
  const text = value.getText();
  if (root !== owner) return /^useRef\s*(<[^>]*>)?\s*\(\s*new\s+(Map|Set|WeakMap|WeakSet)\b/.test(text);
  return COLLECTIONS.test(text) || /^useSearchParams\s*\(/.test(text);
}

/** A press calling one of its component's own props: that value is read where the component is drawn. */
function propCall(node: ts.Identifier | ts.PropertyAccessExpression, source: Source): { fn: Definition; name: string } | null {
  const fn = enclosingComponent(node, source);
  if (!fn) return null;
  const { names, whole } = propNames(fn);
  if (ts.isIdentifier(node) && names.has(node.text)) return { fn, name: names.get(node.text) ?? node.text };
  if (ts.isPropertyAccessExpression(node) && whole && node.expression.getText() === whole) return { fn, name: node.name.text };
  return null;
}

/** A prop a component presses is judged by what each place drawing it gives it, through a spread of props included. */
function propVerdict(fn: Definition, prop: string, reading: Reading): Verdict {
  const uses = reading.index.uses.get(fn) ?? [];
  if (!uses.length) return refused(`no place draws the component pressing ${prop}, so what it is handed cannot be read`);
  for (const use of uses) {
    const given = attributeValue(attribute(use.element, prop));
    if (given) {
      const verdict = handedVerdict(use.element, prop, given, use.source, reading);
      if (!verdict.ok) return verdict;
      continue;
    }
    for (const spread of use.element.attributes.properties.filter(ts.isJsxSpreadAttribute)) {
      const outer = enclosingComponent(spread, use.source);
      const passes = outer && [propNames(outer).rest, propNames(outer).whole].includes(spread.expression.getText());
      const verdict = passes ? propVerdict(outer, prop, deeper(reading)) : OK;
      if (!verdict.ok) return verdict;
    }
  }
  return OK;
}

/** A value handed to an element: the one Retry's where the element is it, else what pressing it does. */
function handedVerdict(element: ts.JsxOpeningLikeElement, prop: string, value: ts.Expression, source: Source, reading: Reading): Verdict {
  if (landsInRule(element, prop)) return OK;
  const verdict = pressVerdict(value, source, deeper(reading));
  return verdict.ok ? OK : refused(`${where(element)} hands <${tagName(element)}> ${prop}, and ${verdict.why}`);
}

/** Whether a value handed as `prop` lands in the one Retry. */
function landsInRule(element: ts.JsxOpeningLikeElement, prop: string): boolean {
  const tag = tagName(element);
  if (insideRetryButton(element) || RETRY_PRIMITIVES.has(tag)) return true;
  return FAILURE_PRIMITIVES.has(tag) && prop === "onRetry" && givenAnError(element);
}

/** Whether a failure part is given a read's error: given one, and not a null or undefined written in its place. */
function givenAnError(element: ts.JsxOpeningLikeElement): boolean {
  const value = attributeValue(attribute(element, "error"));
  if (!value) return false;
  const nothing = (n: ts.Node | undefined) => !!n && (n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === "undefined"));
  const held = ts.isIdentifier(value) ? constantsOf(element.getSourceFile()).get(value.text) : undefined;
  return !nothing(value) && !nothing(held);
}

/** Whether a component presses what it is handed as `prop`: on an element's handler, a menu item's, by handing it on
 *  to a part that does, or by calling it inside one of those. */
function pressesProp(fn: Definition, prop: string, reading: Reading): boolean {
  const source = reading.index.files.get(fn.getSourceFile().fileName);
  if (!source || relative(SRC, source.path) in ACTS || reading.depth > 5 || !fn.body) return false;
  const { names, whole, rest } = propNames(fn);
  const local = new Set([...names].filter(([, key]) => key === prop).map(([name]) => name));
  let pressed = false;
  const named = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && local.has(node.text) && !ts.isBindingElement(node.parent)) ||
    (whole !== null && ts.isPropertyAccessExpression(node) && node.expression.getText() === whole && node.name.text === prop);
  // Pressed is called, or handed on whole: a prop read inside a handler (`push(\`/p/${slug}\`)`) is data, not a press.
  const reached = (node: ts.Node): boolean => named(node) && handedWhole(node);
  const lands = (element: ts.JsxOpeningLikeElement, name: string, at: ts.Node): boolean => {
    if (insideRetryButton(at) || landsInRule(element, name)) return false;
    const tag = tagName(element);
    if (/^[a-z]/.test(tag)) return PRESS.test(name) && !NOT_A_PRESS.has(name);
    const defs = resolve(source, tag, reading.index);
    return defs.length ? defs.some((d) => pressesProp(d, name, deeper(reading))) : PRESS.test(name);
  };
  const follow = (use: ts.Node) => {
    for (let at: ts.Node = use.parent; at && at !== fn; at = at.parent) {
      if (ts.isJsxAttribute(at)) {
        if (lands(elementOf(at), at.name.getText(), at)) pressed = true;
        return;
      }
      if (ts.isPropertyAssignment(at) || ts.isShorthandPropertyAssignment(at)) {
        if (ITEM_PRESS.test(at.name.getText()) && !insideRetryButton(at)) pressed = true;
        return;
      }
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) {
        local.add(at.name.text);
        return;
      }
    }
  };
  for (let size = -1; size !== local.size && !pressed; ) {
    size = local.size;
    const visit = (node: ts.Node) => {
      if (pressed) return;
      if (reached(node)) follow(node);
      if (ts.isJsxSpreadAttribute(node) && [rest, whole].includes(node.expression.getText()) && lands(elementOf(node), prop, node)) pressed = true;
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  }
  return pressed;
}

/** Whether a value stands where it is called or handed on whole: a callee, an attribute's or a property's whole
 *  value, or a name given to it. */
function handedWhole(node: ts.Node): boolean {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent;
  const parent = at.parent;
  if (ts.isCallExpression(parent)) return parent.expression === at;
  if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) return handedWhole(parent);
  if (ts.isConditionalExpression(parent)) return parent.condition !== at && handedWhole(parent);
  return ts.isJsxExpression(parent) || ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isJsxSpreadAttribute(parent);
}

/** The outermost element of the JSX a node is written in, climbing only through elements that hold it directly; an
 *  object literal (a toast, a menu item) where the node is one of its values. */
function regionRoot(node: ts.Node): ts.Node | null {
  let element: ts.Node | null = null;
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at) || ts.isJsxFragment(at)) {
      element = at;
      break;
    }
    if (ts.isObjectLiteralExpression(at)) return at;
    if (ts.isFunctionLike(at) || ts.isSourceFile(at)) return null;
  }
  while (element?.parent && (ts.isJsxElement(element.parent) || ts.isJsxFragment(element.parent))) element = element.parent;
  return element;
}

/** Whether a condition names a read's failure: `q.isError`, `failed`, `status === "error"`, `unread`. */
function namesFailure(condition: ts.Node): boolean {
  let named = false;
  const visit = (node: ts.Node) => {
    if (named) return;
    if ((ts.isIdentifier(node) && FAILURE_GUARD.test(node.text)) || (ts.isStringLiteral(node) && node.text === "error")) named = true;
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return named;
}

function returned(statement: ts.Statement): ts.Expression | undefined {
  if (ts.isReturnStatement(statement)) return statement.expression;
  return ts.isBlock(statement) ? statement.statements.find(ts.isReturnStatement)?.expression : undefined;
}

/** After `if (!failed) return …;`, what the rest of the function returns is the failed state. */
function nextReturn(guard: ts.IfStatement): ts.Expression | undefined {
  const block = guard.parent;
  if (!ts.isBlock(block)) return undefined;
  return block.statements.slice(block.statements.indexOf(guard) + 1).find(ts.isReturnStatement)?.expression;
}

/** Every failed read's state a file draws: around failure words, a failure part or a Retry, or a branch a failure guards. */
function failureRegions(source: Source): Set<ts.Node> {
  const regions = new Set<ts.Node>();
  const add = (node: ts.Node | undefined) => {
    const root = node && regionRoot(node);
    if (root) regions.add(root);
  };
  // A guarded branch is the failed state where it draws something: JSX of its own, never the element around a null.
  const branch = (node: ts.Node | undefined) => {
    let at = node;
    while (at && ts.isParenthesizedExpression(at)) at = at.expression;
    if (at && (ts.isJsxElement(at) || ts.isJsxSelfClosingElement(at) || ts.isJsxFragment(at))) regions.add(at);
  };
  const visit = (node: ts.Node) => {
    const literal = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
    const held = ts.isIdentifier(node) && ts.isJsxExpression(node.parent);
    const words = literal || held ? wordsOf(node, source.constants) : null;
    if (words !== null && FAILURE_WORDS.test(words)) add(node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node);
      // A failure part is that state itself, and what stands beside it is not. A larger part drawing one is read in
      // its own file, where a prop it presses there is followed back to each place that draws it.
      if (RETRY_PRIMITIVES.has(tag) || FAILURE_PRIMITIVES.has(tag)) regions.add(node);
    }
    if (ts.isConditionalExpression(node) && namesFailure(node.condition)) branch(node.whenTrue);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && namesFailure(node.left)) branch(node.right);
    if (ts.isIfStatement(node) && namesFailure(node.expression)) {
      const negated = ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken;
      branch(negated ? nextReturn(node) : returned(node.thenStatement));
    }
    ts.forEachChild(node, visit);
  };
  visit(source.file);
  return regions;
}

/** Whether an element links to the page it stands on, which loads it again. */
function linksHere(element: ts.JsxOpeningLikeElement): boolean {
  const href = attributeValue(attribute(element, "href"));
  return !!href && !ts.isStringLiteral(href) && /location|pathname|asPath|searchParams/.test(href.getText());
}

type Excuse = (handler: ts.Node) => boolean;

/** Every press inside a failed read's state the reading cannot resolve to what it recognises. */
function unresolvedPresses(source: Source, index: Index, excused: Excuse): string[] {
  const found = new Map<number, string>();
  const at = (node: ts.Node, what: string) => {
    if (!found.has(node.getStart())) found.set(node.getStart(), `${where(node)} ${what}`);
  };
  const reading = (): Reading => ({ index, depth: 0, seen: new Set() });
  const judge = (node: ts.Node, name: string, value: ts.Node, on: string) => {
    if (excused(value)) return;
    const verdict = pressVerdict(value, source, reading());
    if (!verdict.ok) at(node, `${name} ${on} in a failed read's state is not RetryButton, the one rule: ${verdict.why}`);
  };
  for (const region of failureRegions(source)) {
    const visit = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && !insideRetryButton(node)) {
        const tag = tagName(node);
        const intrinsic = /^[a-z]/.test(tag);
        const defs = intrinsic ? [] : resolve(source, tag, index);
        if (linksHere(node)) at(node, `<${tag}> in a failed read's state links to the page it stands on, a read made again outside RetryButton, the one rule`);
        if (FAILURE_PRIMITIVES.has(tag) && attribute(node, "onRetry") && attribute(node, "error") && !givenAnError(node)) {
          at(node, `<${tag}> is given onRetry with no read's error in its error`);
        }
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          const name = attr.name.getText();
          const value = attributeValue(attr);
          if (!value || NOT_A_PRESS.has(name) || landsInRule(node, name) || (FAILURE_PRIMITIVES.has(tag) && name === "onRetry")) continue;
          const pressed = intrinsic || !defs.length ? PRESS.test(name) : defs.some((d) => pressesProp(d, name, reading()));
          if (pressed) judge(attr, name, value, `on <${tag}>`);
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const p of node.properties) {
          const name = p.name?.getText() ?? "";
          if (!ITEM_PRESS.test(name)) continue;
          const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : ts.isMethodDeclaration(p) ? p : null;
          if (value) judge(p, name, value, "on an item");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(region);
  }
  return [...found.values()];
}

/** Whether an element is a live region, which a screen reader announces as what is inside it changes. */
function liveRegion(element: ts.JsxOpeningLikeElement): string | null {
  const role = attributeValue(attribute(element, "role"));
  const live = attributeValue(attribute(element, "aria-live"));
  const roles = role ? [...role.getText().matchAll(/"(\w+)"/g)].map((m) => m[1] ?? "") : [];
  const named = roles.find((r) => LIVE_ROLES.has(r));
  if (named) return `role="${named}"`;
  return live && /polite|assertive/.test(live.getText()) ? `aria-live=${live.getText()}` : null;
}

/** The props a component draws inside a live region of its own, `children` among them: a part handed there is live. */
function liveProps(fn: Definition): Set<string> {
  const props = new Set<string>();
  if (!fn.body) return props;
  const { names, whole } = propNames(fn);
  const visit = (node: ts.Node, live: boolean) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    const inside = live || (!!opening && liveRegion(opening) !== null);
    if (inside && ts.isJsxExpression(node) && node.expression) {
      const e = node.expression;
      if (ts.isIdentifier(e) && names.has(e.text)) props.add(names.get(e.text) ?? e.text);
      if (ts.isPropertyAccessExpression(e) && whole && e.expression.getText() === whole) props.add(e.name.text);
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(fn.body, false);
  return props;
}

/** Every one Retry, or part drawing one, written inside a live region, its own or one a part draws around what it is
 *  handed: its wait would be announced each second. */
function waitsInLiveRegions(source: Source, index: Index): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node, live: string | null) => {
    let inside = live;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = tagName(opening);
      const defs = /^[A-Z]/.test(tag) ? resolve(source, tag, index) : [];
      if (inside && defs.some((d) => index.gates.has(d))) {
        found.push(`${where(opening)} <${tag}> counts a wait inside a ${inside} region, which announces every second of it`);
      }
      const wrapped = new Set(defs.flatMap((d) => [...liveProps(d)]));
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.initializer) visit(attr.initializer, inside ?? (wrapped.has(attr.name.getText()) ? `<${tag}> ${attr.name.getText()}` : null));
      }
      inside = inside ?? liveRegion(opening) ?? (wrapped.has("children") ? `<${tag}>` : null);
      if (ts.isJsxElement(node)) for (const child of node.children) visit(child, inside);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source.file, null);
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

function inJsx(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxExpression(at)) return true;
    if (ts.isJsxAttribute(at) || ts.isBlock(at) || ts.isSourceFile(at)) return false;
  }
  return false;
}

/** Whether an expression is a sentence already closed: a sentence call, a failure's `said`, either branch of a
 *  choice, a helper returning one, or a name given one where it is declared or later assigned (ISS-1229 r53,
 *  judge-165's r1 to r7). */
function isSentence(node: ts.Node, constants: Map<string, ts.Node>, seen = new Set<string>()): boolean {
  if (SENTENCE_CALLS.has(callName(node) ?? "")) return true;
  if (ts.isParenthesizedExpression(node)) return isSentence(node.expression, constants, seen);
  if (ts.isConditionalExpression(node)) return isSentence(node.whenTrue, constants, seen) || isSentence(node.whenFalse, constants, seen);
  if (ts.isPropertyAccessExpression(node) && node.name.text === "said") return callName(node.expression) === "readFailure" || isSentence(node.expression, constants, seen);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !seen.has(node.expression.text)) {
    const fn = constants.get(node.expression.text);
    const body = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) ? fn.body : undefined;
    const next = new Set([...seen, node.expression.text]);
    if (body && !ts.isBlock(body)) return isSentence(body, constants, next);
    if (body) return body.statements.some((st) => ts.isReturnStatement(st) && !!st.expression && isSentence(st.expression, constants, next));
    return false;
  }
  if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
  const next = new Set([...seen, node.text]);
  const held = constants.get(node.text);
  if (held && ts.isBindingElement(held)) {
    const declared = held.parent.parent;
    const key = (held.propertyName ?? held.name).getText();
    return key === "said" && ts.isVariableDeclaration(declared) && callName(declared.initializer ?? held) === "readFailure";
  }
  if (held !== undefined && isSentence(held, constants, next)) return true;
  return assignedTo(node).some((value) => isSentence(value, constants, next));
}

/** Every value a name is given after it is declared: `why = formatApiError(e)`. */
function assignedTo(name: ts.Identifier): ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name.text) values.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(name.getSourceFile());
  return values;
}

function sentenceEnds(node: ts.Expression, constants: Map<string, ts.Node>): boolean {
  if (isSentence(node, constants)) return true;
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && sentenceEnds(node.right, constants);
}

/** Words drawn or named that only RetryButton may draw, failure parts handed onRetry without an error, and a
 *  failure sentence closed by a second stop. */
function wordOffences(source: Source): string[] {
  const { file, constants } = source;
  const rel = relative(SRC, source.path);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) => found.push(`${where(node)} ${what}`);
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
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && FAILURE_PRIMITIVES.has(tagName(node)) && attribute(node, "onRetry") && !attribute(node, "error")) {
      at(node, `<${tagName(node)}> is given onRetry without the failed read's error`);
    }
    if (ts.isTemplateSpan(node) && isSentence(node.expression, constants) && node.literal.text.startsWith(".")) {
      at(node, "closes a sentence that already ends with its own stop");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && sentenceEnds(node.left, constants) && (wordsOf(node.right, constants) ?? "").startsWith(".")) {
      at(node, "closes a sentence that already ends with its own stop");
    }
    if (ts.isJsxExpression(node) && node.expression && isSentence(node.expression, constants)) {
      const siblings = node.parent.getChildren(file).flatMap((c) => (c.kind === ts.SyntaxKind.SyntaxList ? c.getChildren(file) : [c]));
      const next = siblings[siblings.indexOf(node) + 1];
      // The stop may stand on the next line, as a formatter writes a long one, or as an expression of its own.
      const stop = next && (ts.isJsxText(next) ? next.text.trimStart() : ts.isJsxExpression(next) ? (wordsOf(next, constants) ?? "") : "");
      if (stop?.startsWith(".")) at(node, "closes a sentence that already ends with its own stop");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function writes(node: ts.Node, constants: Map<string, ts.Node>, seen: Set<string>): boolean {
  let found = false;
  const visit = (at: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(at) && isWrite(at)) found = true;
    else if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && !seen.has(at.expression.text)) {
      const held = constants.get(at.expression.text);
      if (held && writes(held, constants, new Set([...seen, at.expression.text]))) found = true;
    }
    ts.forEachChild(at, visit);
  };
  visit(ts.isIdentifier(node) ? (constants.get(node.text) ?? node) : node);
  return found;
}

/** Whether a handler reads something again by a call this reading knows, written in place or behind a name. */
function readsAgain(node: ts.Node, constants: Map<string, ts.Node>, seen = new Set<string>()): boolean {
  if (ts.isIdentifier(node)) {
    if (READ_AGAIN_NAME.test(node.text) || READ_AGAIN_CALLS.has(node.text)) return true;
    const held = constants.get(node.text);
    if (!held || seen.has(node.text)) return false;
    seen.add(node.text);
    return readsAgain(held, constants, seen);
  }
  if (ts.isPropertyAccessExpression(node)) return READ_AGAIN_CALLS.has(node.name.text) || READ_AGAIN_NAME.test(node.name.text);
  let found = false;
  const visit = (at: ts.Node) => {
    if (found) return;
    const name = callName(at);
    if (name && (READ_AGAIN_CALLS.has(name) || READ_AGAIN_NAME.test(name))) found = true;
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

/** Whether the parts a tag names press what they are handed as `name`: a part the reading cannot place presses
 *  any handler it is handed. */
function pressedBy(defs: Definition[], name: string, index: Index): boolean {
  return defs.length ? defs.some((d) => pressesProp(d, name, { index, depth: 0, seen: new Set() })) : PRESS.test(name) && !NOT_A_PRESS.has(name);
}

/** Anywhere, failed state or not: a press, or a value handed to a part that presses it, that reads again by a call
 *  this reading knows, outside RetryButton. */
function readAgainPresses(source: Source, index: Index, excused: Excuse): string[] {
  const found: string[] = [];
  const { constants } = source;
  const again = (h: ts.Node) => readsAgain(h, constants) && !writes(h, constants, new Set()) && !excused(h);
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && !insideRetryButton(node)) {
      const name = node.name.getText();
      const value = attributeValue(node);
      const element = elementOf(node);
      const tag = tagName(element);
      const failurePart = FAILURE_PRIMITIVES.has(tag) && name === "onRetry";
      if (value && again(value) && !landsInRule(element, name) && !failurePart) {
        if (/^[a-z]/.test(tag) && PRESS.test(name) && !NOT_A_PRESS.has(name)) {
          found.push(`${where(node)} reads again on a press of its own; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
        } else if (/^[A-Z]/.test(tag) && pressedBy(resolve(source, tag, index), name, index)) {
          found.push(`${where(node)} hands a read-again to <${tag}> as ${name}, which presses it outside RetryButton, the one rule`);
        }
      }
    }
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ITEM_PRESS.test(node.name.getText()) && !insideRetryButton(node)) {
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      if (again(value)) found.push(`${where(node)} reads again on a press of its own; a failed read's Retry is RetryButton, which asks isRetryableApiError`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.file);
  return found;
}

/** Every place in one file of the index that breaks the rule, as `path:line what`, one per place. */
export function offencesIn(index: Index, path: string): string[] {
  const source = index.files.get(path);
  if (!source) return [];
  const rel = relative(SRC, path);
  const excused: Excuse = (handler) =>
    rel in ACTS || `${rel}#${handler.getText(source.file)}` in ACTS || identifiersIn(handler).some((name) => `${rel}#${name}` in ACTS);
  const byPlace = new Map<string, string>();
  for (const line of [...readAgainPresses(source, index, excused), ...unresolvedPresses(source, index, excused)]) {
    const place = line.slice(0, line.indexOf(" "));
    if (!byPlace.has(place)) byPlace.set(place, line);
  }
  return [...wordOffences(source), ...byPlace.values(), ...waitsInLiveRegions(source, index)];
}

/** One file's offences, read beside the other files given. */
export function offences(path: string, text: string, others: readonly (readonly [path: string, text: string])[] = []): string[] {
  return offencesIn(indexOf([...others, [path, text]]), path);
}

