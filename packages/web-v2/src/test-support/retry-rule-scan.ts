// The reading behind retry-rule-source.test.ts (criteria 478, 479, 496). It refuses, naming file and line: the words
// only the one Retry draws ("Retry", "Try again", "Reload", "Read it again") drawn or named anywhere else; a failure
// part handed onRetry without the failed read's error; a failure sentence closed by a second stop; and the one
// Retry's wait counted inside a live region, which would announce every second of it.
//
// It follows no press (ISS-1229 r54). Whether a read refused with a wait is asked again before that wait ends is
// decided where the read is sent: the API client holds it, whoever asks and however, a changed key, an effect run
// again and a reload included (lib/api/client.ts, held-reads.test.tsx). Four judges found presses a reading of the
// source could not follow; the client sees them all. What it cannot see is a request sent around it, which
// retry-rule-source.test.ts refuses by name.
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export const SRC = join(__dirname, "..");

/** The words a control that reads something again is drawn with, as its text, its accessible name or its title. */
const RETRY_WORDS = /^(Retry\b.*|Retrying…|Try again\b.*|Reload\b.*|Read (it |them )?again\b.*)$/;

const NAMING_ATTRIBUTES = new Set(["aria-label", "title", "label"]);

/**
 * Files whose Retry repeats an act rather than a read, so no read's error decides it: each is named with
 * the act, as a whole file or as `file#words` where the same file also reads. Adding one here says, in
 * review, that its Retry is not a failed read's.
 */
export const ACTS: Record<string, string> = {
  "design/primitives/retry-link.tsx": "the one Retry itself, as a word",
  "features/integrations/components/delivery-log-viewer.tsx": "sends a failed webhook delivery again",
  "features/project-settings/components/memory-tab.tsx": "posts a failed reindex again",
  "features/conversations/components/conversation-thread.tsx": "sends a message that failed to send again",
  "features/project-dashboard/components/attention-queue.tsx#Retrying…": "runs a failed job again",
  "app/global-error.tsx": "loads the page again after it failed to draw, where no read's error is held",
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

/** Every place in one file of the index that breaks the rule, as `path:line what`, one per place. */
export function offencesIn(index: Index, path: string): string[] {
  const source = index.files.get(path);
  if (!source) return [];
  return [...wordOffences(source), ...waitsInLiveRegions(source, index)];
}

/** One file's offences, read beside the other files given. */
export function offences(path: string, text: string, others: readonly (readonly [path: string, text: string])[] = []): string[] {
  return offencesIn(indexOf([...others, [path, text]]), path);
}

