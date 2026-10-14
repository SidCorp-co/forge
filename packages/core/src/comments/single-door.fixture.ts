import ts from 'typescript';
import { Model } from './single-door.model.fixture.js';
import {
  type FileFacts,
  type FnInfo,
  TABLE,
  unwrap,
  WRITING_CALLS,
} from './single-door.parse.fixture.js';

/**
 * A finding: `write` is the comments table written, `unresolved` a write whose table the scan could
 * not trace. The second is refused by name, since passing it would say the table is not this one.
 */
export interface CommentWrite {
  file: string;
  line: number;
  how: string;
  kind: 'write' | 'unresolved';
}

const RAW_WRITES = [
  /\binsert\s+into\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
  /\bupdate\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\s+set\b/i,
  /\bdelete\s+from\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
];

/** The builder methods a drizzle write is followed by, which `Map.delete` and `hash.update` are not. */
const BUILDER_CALLS = new Set([
  'values',
  'set',
  'where',
  'returning',
  'onConflictDoNothing',
  'onConflictDoUpdate',
  '$dynamic',
  'execute',
  'prepare',
  'then',
]);

const lineOf = (f: FileFacts, node: ts.Node): number =>
  f.sf.getLineAndCharacterOfPosition(node.getStart(f.sf)).line + 1;

/** The method a call names when it is a write, `*` when the method is picked at run time. */
function writeMethod(callee: ts.Expression): { name: string; at: ts.Node } | null {
  if (ts.isPropertyAccessExpression(callee) && WRITING_CALLS.has(callee.name.text)) {
    return { name: callee.name.text, at: callee.name };
  }
  if (!ts.isElementAccessExpression(callee)) return null;
  const key = callee.argumentExpression;
  if (!ts.isStringLiteralLike(key)) return { name: '*', at: key };
  return WRITING_CALLS.has(key.text) ? { name: key.text, at: key } : null;
}

/** Whether the call is followed by what only a drizzle write is followed by. */
function isBuilderShaped(call: ts.CallExpression): boolean {
  let parent = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === call) return true;
  return ts.isPropertyAccessExpression(parent) && BUILDER_CALLS.has(parent.name.text);
}

function lineNode(callee: ts.Expression): ts.Node {
  return ts.isPropertyAccessExpression(callee) ? callee.name : callee;
}

/** Per function, the parameters it hands to a write, and whether that write is drizzle-shaped. */
type Writers = Map<FnInfo, Map<number, boolean>>;

/** One pass over a file's calls: what each hands a table to, and what that function hands on. */
class Inspector {
  changed = false;

  constructor(
    private readonly model: Model,
    private readonly writers: Writers,
    private readonly f: FileFacts,
    private readonly out: CommentWrite[] | null,
  ) {}

  private report(at: ts.Node, kind: CommentWrite['kind'], how: string): void {
    this.out?.push({ file: this.f.file, line: lineOf(this.f, at), how, kind });
  }

  private mark(fn: FnInfo, index: number, strict: boolean): void {
    const params = this.writers.get(fn) ?? new Map<number, boolean>();
    this.writers.set(fn, params);
    const held = params.get(index);
    if (held === undefined || (strict && !held)) {
      params.set(index, strict || (held ?? false));
      this.changed = true;
    }
  }

  /** Follow one argument that is handed to a write, `strict` being when a write is the only reading. */
  private table(arg: ts.Expression | undefined, at: ts.Node, label: string, strict: boolean): void {
    if (!arg) return;
    if (ts.isSpreadElement(arg)) {
      if (strict)
        this.report(at, 'unresolved', `${label}: a spread hides which argument is the table`);
      return;
    }
    const ev = this.model.evalOwn(arg, this.f.file);
    if (ev.values.has(TABLE)) {
      this.report(at, 'write', label);
      return;
    }
    const bare = unwrap(arg);
    const param = ts.isIdentifier(bare) ? this.model.paramOf(bare) : null;
    if (param) {
      if (param.primitive) return;
      if (param.fn && param.index >= 0) {
        this.mark(param.fn, param.index, strict);
        return;
      }
      if (this.model.eval(arg, this.f.file).values.has(TABLE)) {
        this.report(at, 'write', label);
      } else if (strict) {
        this.report(
          at,
          'unresolved',
          `${label}: \`${bare.getText()}\` is a parameter of a function the scan cannot follow to its callers`,
        );
      }
      return;
    }
    if (this.isPrimitiveMemberOfParam(bare)) return;
    if (ev.unknown && strict) {
      this.report(
        at,
        'unresolved',
        `${label}: the table is ${ev.unknown}, which the scan cannot follow`,
      );
    } else if (strict && ts.isCallExpression(bare) && !this.model.resolvesCall(bare, this.f.file)) {
      this.report(
        at,
        'unresolved',
        `${label}: the table is the result of a call the scan cannot enter`,
      );
    }
  }

  /** `row.path`, `opts.a.b`: a member of a parameter whose declared type makes it a string or a number. */
  private isPrimitiveMemberOfParam(node: ts.Expression): boolean {
    const path: string[] = [];
    let root = node;
    while (ts.isPropertyAccessExpression(root)) {
      path.unshift(root.name.text);
      root = unwrap(root.expression);
    }
    if (!ts.isIdentifier(root) || path.length === 0) return false;
    const param = this.model.paramOf(root);
    return !!param && this.model.primitiveMember(param.type, path, this.f.file);
  }

  calls(): void {
    for (const call of this.f.calls) {
      const callee = unwrap(call.expression);
      const write = writeMethod(callee);
      const [first] = call.arguments;
      if (write && first) {
        const label = `.${write.name === '*' ? '[…]' : write.name}(${first.getText().slice(0, 40)})`;
        if (write.name === '*') this.tableIfProven(first, write.at, label);
        else this.table(first, write.at, label, isBuilderShaped(call));
      }
      for (const fn of this.model.fnsOf(this.model.eval(callee, this.f.file))) {
        for (const [index, strict] of [...(this.writers.get(fn) ?? [])]) {
          const spread = call.arguments.slice(0, index + 1).some((a) => ts.isSpreadElement(a));
          const label = `${callee.getText().slice(0, 40)}(${call.arguments.map((a) => a.getText().slice(0, 20)).join(', ')})`;
          if (spread && strict) {
            this.report(
              lineNode(callee),
              'unresolved',
              `${label}: a spread hides which argument is the table`,
            );
          } else if (!spread) this.table(call.arguments[index], lineNode(callee), label, strict);
        }
      }
    }
  }

  private tableIfProven(arg: ts.Expression, at: ts.Node, label: string): void {
    if (this.model.evalOwn(arg, this.f.file).values.has(TABLE)) this.report(at, 'write', label);
  }

  /** What is used as a value rather than called: a write method, or a helper that writes a table. */
  references(helpers: boolean): void {
    for (const node of this.f.refs) {
      const parent = node.parent;
      const called = ts.isCallExpression(parent) && unwrap(parent.expression) === node;
      if (called || isDeclaration(node)) continue;
      if (isBoundWriteMethod(node)) {
        this.report(
          node,
          'unresolved',
          `\`${node.getText().slice(0, 40)}\` is taken as a value, so what table it is given is out of the scan's sight`,
        );
        continue;
      }
      if (!helpers || !(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) continue;
      const strictHelper = this.model
        .fnsOf(this.model.eval(node as ts.Expression, this.f.file))
        .find((fn) => [...(this.writers.get(fn)?.values() ?? [])].some(Boolean));
      if (strictHelper) {
        this.report(
          node,
          'unresolved',
          `\`${strictHelper.name}\` hands a table to a write and is used here as a value, so what table it is given is out of the scan's sight`,
        );
      }
    }
    for (const pattern of this.f.declarations) {
      if (!ts.isObjectBindingPattern(pattern.name)) continue;
      for (const el of pattern.name.elements) {
        const key = (el.propertyName ?? el.name).getText();
        if (WRITING_CALLS.has(key))
          this.report(
            el,
            'unresolved',
            `\`${key}\` is taken out of an object as a value, so what table it is given is out of the scan's sight`,
          );
      }
    }
  }

  strings(): void {
    for (const node of this.f.strings) {
      if (RAW_WRITES.some((re) => re.test(node.text)))
        this.report(node, 'write', 'raw SQL on comments');
    }
  }
}

/** `db.insert.bind(db)`, `db.update.call(db, t)`: the write method used without being called as one. */
function isBoundWriteMethod(node: ts.Node): boolean {
  const named = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : null;
  const parent = node.parent;
  return (
    named !== null &&
    WRITING_CALLS.has(named) &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    ['bind', 'call', 'apply'].includes(parent.name.text)
  );
}

/** Whether an identifier names a thing where it is declared, imported or exported, not where it is used. */
function isDeclaration(node: ts.Node): boolean {
  const p = node.parent;
  if (!ts.isIdentifier(node)) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (
    ts.isQualifiedName(p) ||
    ts.isTypeReferenceNode(p) ||
    (ts.isPropertyAssignment(p) && p.name === node)
  )
    return true;
  if (
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isBindingElement(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isNamespaceExport(p) ||
    ts.isLabeledStatement(p)
  ) {
    return true;
  }
  return false;
}

/**
 * Every place the given sources write the comments table, outside the files allowed to, and every
 * write they make through a shape the scan cannot follow.
 *
 * The table is the export declared as `pgTable('comments', ...)`, followed through every import of
 * it, re-export, namespace (however re-exported or renamed), destructuring, alias and function that
 * returns it (`single-door.model.fixture.ts`). A write is an `insert`, `update` or `delete` call
 * given that table, a call of a helper that hands one of its parameters to such a call, or a raw SQL
 * string that writes a table named `comments`. A comment that merely says `insert(comments)` is not.
 *
 * What the scan cannot trace to a table is refused by name and never passed: a computed key, a
 * `this` member, the result of a call it cannot enter, a helper reached through a method, a callback
 * or a destructured parameter, a helper used as a value, a write method taken as a value. A
 * parameter typed as a primitive cannot be a table, and a call that is not shaped like a drizzle
 * write (`Map.delete`, `hash.update`) is not refused for its argument. What a call hands a function
 * is followed into its parameters, so a method of an object handed in is read where it is handed.
 */
export function commentWrites(
  sources: ReadonlyMap<string, string>,
  doors: ReadonlySet<string>,
): CommentWrite[] {
  const model = new Model(sources);
  const writers: Writers = new Map();
  const scanned = [...model.facts.values()].filter((f) => !doors.has(f.file));

  for (let changed = true; changed; ) {
    changed = false;
    for (const f of scanned) {
      const pass = new Inspector(model, writers, f, null);
      pass.calls();
      changed = pass.changed || changed;
    }
  }

  const found: CommentWrite[] = [];
  const anyHelper = writers.size > 0;
  for (const f of scanned) {
    const pass = new Inspector(model, writers, f, found);
    pass.calls();
    pass.references(anyHelper);
    pass.strings();
  }
  return found.sort((a, c) => a.file.localeCompare(c.file) || a.line - c.line);
}
