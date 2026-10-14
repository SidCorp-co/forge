import ts from 'typescript';
import type { Model } from './single-door.model.fixture.js';
import { type FileFacts, TABLE, unwrap } from './single-door.parse.fixture.js';

/** Stands for a part of a text that could not be read. */
const UNREAD = '\uE000';

/**
 * Between a write verb and its table: space, or nothing where the table is quoted (drizzle writes an
 * interpolated table as `"comments"`, so a verb appended to it may have no space before it).
 */
const BEFORE_TABLE = String.raw`(?:\s+(?:only\s+)?|(?="))(?:"?public"?\.)?"?`;
const BEFORE_UNREAD = String.raw`(?:\s+(?:only\s+)?|(?=["\uE000]))(?:"?public"?\.)?"?`;

export const WRITES_ON_COMMENTS = [
  new RegExp(String.raw`\binsert\s+into${BEFORE_TABLE}comments"?\b`, 'i'),
  new RegExp(String.raw`\bupdate${BEFORE_TABLE}comments"?\s+set\b`, 'i'),
  new RegExp(String.raw`\bdelete\s+from${BEFORE_TABLE}comments"?\b`, 'i'),
];

/** SQL-shaped, so a sentence that says "update" is not one: a write verb whose table is unread. */
const WRITE_OF_UNREAD = new RegExp(
  String.raw`\b(?:(?:insert\s+into|delete\s+from)${BEFORE_UNREAD}\uE000|update${BEFORE_UNREAD}\uE000"?\s+set\b)`,
  'i',
);

/**
 * A write verb with no table after it in the text that holds it: the table is supplied by a part
 * the text is later joined to or appended onto, out of this text's sight. A bare verb only counts
 * where it is the whole text, so a sentence ending in "update" is not one.
 */
const DANGLING_WRITE = [
  /\b(?:insert\s+into|delete\s+from)(?:\s+only)?(?:\s+"?public"?\.)?\s*$/i,
  /^\s*(?:insert(?:\s+into)?|delete(?:\s+from)?|update)(?:\s+only)?\s*$/i,
];

export interface RawFinding {
  at: ts.Node;
  kind: 'write' | 'unresolved';
  how: string;
}

/** The text an expression builds, each part it could not read left as `UNREAD`. */
class TextReader {
  private depth = 0;

  constructor(
    private readonly model: Model,
    private readonly f: FileFacts,
  ) {}

  read(expr: ts.Expression): string {
    const node = unwrap(expr);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce(
        (text, span) => text + this.part(span.expression) + span.literal.text,
        node.head.text,
      );
    }
    if (ts.isTaggedTemplateExpression(node)) return this.read(node.template);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.read(node.left) + this.read(node.right);
    }
    if (ts.isCallExpression(node)) {
      const composing = composition(node);
      if (composing === 'raw') return this.read(node.arguments[0] as ts.Expression);
      if (composing === 'append') {
        const receiver = (unwrap(node.expression) as ts.PropertyAccessExpression).expression;
        return this.read(receiver) + this.part(node.arguments[0] as ts.Expression);
      }
      if (composing === 'join') return this.joined(node);
    }
    if (ts.isIdentifier(node)) {
      const held = this.constant(node);
      return held ? this.nested(() => this.read(held)) : UNREAD;
    }
    return UNREAD;
  }

  private part(expr: ts.Expression): string {
    if (this.model.evalOwn(expr, this.f.file).values.has(TABLE)) return '"comments"';
    return this.read(expr);
  }

  /** `sql.join(parts, separator)`: each part read in order with the separator between, a space where none is given. */
  private joined(call: ts.CallExpression): string {
    const [list, separator] = call.arguments;
    let parts = list ? unwrap(list) : undefined;
    if (parts && ts.isIdentifier(parts)) {
      const held = this.constant(parts);
      parts = held ? unwrap(held) : undefined;
    }
    if (!parts || !ts.isArrayLiteralExpression(parts)) return UNREAD;
    const between = separator ? this.read(separator) : ' ';
    return parts.elements.map((one) => this.part(one)).join(between);
  }

  private nested(read: () => string): string {
    if (this.depth > 6) return UNREAD;
    this.depth += 1;
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }

  /** What a name the file declares once with `const` holds: a `let` or `var` can hold another by the time it is used. */
  private constant(id: ts.Identifier): ts.Expression | null {
    const declared = this.f.declarations.filter(
      (d) => ts.isIdentifier(d.name) && d.name.text === id.text,
    );
    const [only] = declared;
    if (declared.length !== 1 || !only?.initializer) return null;
    return only.parent.flags & ts.NodeFlags.Const ? only.initializer : null;
  }
}

type Composition = 'raw' | 'join' | 'append';

/**
 * Which of drizzle's ways of building SQL out of parts a call is: `sql.raw(text)`,
 * `sql.join(parts, separator)` or `query.append(part)`. Their text is read through, never skipped.
 */
function composition(call: ts.CallExpression): Composition | null {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const n = call.arguments.length;
  const name = callee.name.text;
  if (name === 'raw' && n === 1) return 'raw';
  if (name === 'append' && n === 1) return 'append';
  if (name === 'join' && (n === 1 || n === 2)) return 'join';
  return null;
}

/** Whether a text is read as a part of a larger one, so the larger one, not this part alone, is judged. */
function readAsAPart(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isTemplateSpan(parent) || ts.isTaggedTemplateExpression(parent)) return true;
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
  if (ts.isCallExpression(parent)) {
    return composition(parent) !== null && parent.arguments.some((arg) => arg === child);
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
    const call = parent.parent;
    return (
      ts.isCallExpression(call) && call.expression === parent && composition(call) === 'append'
    );
  }
  if (ts.isArrayLiteralExpression(parent)) {
    const call = parent.parent;
    return (
      ts.isCallExpression(call) && composition(call) === 'join' && call.arguments[0] === parent
    );
  }
  return false;
}

/**
 * Raw SQL a file builds that writes the comments table, or writes a table the scan could not read
 * the name of: an interpolated drizzle table, a concatenation, a constant, a template. A string
 * that names a table in plain text is read where it stands; one that leaves the name to a part the
 * scan cannot read is refused by name.
 */
export function rawSqlFindings(model: Model, f: FileFacts): RawFinding[] {
  const reader = new TextReader(model, f);
  const found: RawFinding[] = [];
  const built = [...f.texts, ...f.calls.filter((call) => composition(call) !== null)];
  const quote = (node: ts.Node): string => node.getText().replace(/\s+/g, ' ').slice(0, 50);
  for (const node of built.filter((one) => !readAsAPart(one))) {
    const text = reader.read(node);
    if (WRITES_ON_COMMENTS.some((re) => re.test(text))) {
      found.push({ at: node, kind: 'write', how: 'raw SQL on comments' });
    } else if (WRITE_OF_UNREAD.test(text)) {
      found.push({
        at: node,
        kind: 'unresolved',
        how: `raw SQL writes a table the scan cannot read the name of: \`${quote(node)}\``,
      });
    } else if (DANGLING_WRITE.some((re) => re.test(text))) {
      found.push({
        at: node,
        kind: 'unresolved',
        how: `raw SQL holds a write verb whose table is joined or appended out of the scan's sight: \`${quote(node)}\``,
      });
    }
  }
  return found;
}
