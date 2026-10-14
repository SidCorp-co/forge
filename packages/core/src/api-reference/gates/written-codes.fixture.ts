import ts from 'typescript';

/**
 * Every string a set of source files writes, except the arguments of a `fail(...)` call: a code a
 * descriptor declares is not a place any handler writes it. Read from the syntax tree, so a comment,
 * a regular expression or a string that says `fail(` is what it is and a file that leaves a quote open
 * cannot reach the next.
 */
export function stringsWrittenOutsideDeclarations(texts: Iterable<string>): Set<string> {
  const written = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fail'
    ) {
      return;
    }
    if (ts.isStringLiteral(node)) written.add(node.text);
    ts.forEachChild(node, visit);
  };
  for (const text of texts) {
    visit(ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  }
  return written;
}
