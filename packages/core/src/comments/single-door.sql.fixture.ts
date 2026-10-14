import ts from 'typescript';
import type { Model } from './single-door.model.fixture.js';
import { type FileFacts, TABLE, unwrap } from './single-door.parse.fixture.js';

/** Stands for a part of a text that could not be read. */
const UNREAD = '\uE000';

export const WRITES_ON_COMMENTS = [
  /\binsert\s+into\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
  /\bupdate\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\s+set\b/i,
  /\bdelete\s+from\s+(?:only\s+)?(?:"?public"?\.)?"?comments"?\b/i,
];

/** SQL-shaped, so a sentence that says "update" is not one: a write verb whose table is unread. */
const WRITE_OF_UNREAD =
  /\b(?:(?:insert\s+into|delete\s+from)\s+(?:only\s+)?(?:"?public"?\.)?"?\uE000|update\s+(?:only\s+)?(?:"?public"?\.)?"?\uE000"?\s+set\b)/i;

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
    if (ts.isCallExpression(node) && isRaw(node.expression) && node.arguments[0]) {
      return this.read(node.arguments[0]);
    }
    if (ts.isIdentifier(node)) return this.constant(node);
    return UNREAD;
  }

  /** A part of a template: the comments table, a text it can read, or nothing it can. */
  private part(expr: ts.Expression): string {
    if (this.model.evalOwn(expr, this.f.file).values.has(TABLE)) return 'comments';
    return this.read(expr);
  }

  /** The text of a name the file declares once, as a constant. */
  private constant(id: ts.Identifier): string {
    const declared = this.f.declarations.filter(
      (d) => ts.isIdentifier(d.name) && d.name.text === id.text,
    );
    const [only] = declared;
    if (declared.length !== 1 || !only?.initializer || this.depth > 6) return UNREAD;
    this.depth += 1;
    try {
      return this.read(only.initializer);
    } finally {
      this.depth -= 1;
    }
  }
}

/** `sql.raw(x)`: the call that hands text to the database as written. */
function isRaw(callee: ts.Expression): boolean {
  const node = unwrap(callee);
  return ts.isPropertyAccessExpression(node) && node.name.text === 'raw';
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
  for (const node of f.texts) {
    const text = reader.read(node);
    if (WRITES_ON_COMMENTS.some((re) => re.test(text))) {
      found.push({ at: node, kind: 'write', how: 'raw SQL on comments' });
    } else if (WRITE_OF_UNREAD.test(text)) {
      found.push({
        at: node,
        kind: 'unresolved',
        how: `raw SQL writes a table the scan cannot read the name of: \`${node.getText().replace(/\s+/g, ' ').slice(0, 50)}\``,
      });
    }
  }
  return found;
}
