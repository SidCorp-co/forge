import ts from 'typescript';

/** The local name a file gives `fail` from `declare/describe.ts`, if it imports it. */
function declarationName(file: ts.SourceFile): string | null {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!/(?:^|\/)describe\.js$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'fail') return element.name.text;
    }
  }
  return null;
}

/**
 * Every string a set of source files writes, except the arguments of the `fail(...)` call a file
 * imports from `describe.js`: a code a descriptor declares is not a place any handler writes it.
 * Read from the syntax tree, so a comment, a regular expression or a string that says `fail(` is what
 * it is and a file that leaves a quote open cannot reach the next.
 */
export function stringsWrittenOutsideDeclarations(texts: Iterable<string>): Set<string> {
  const written = new Set<string>();
  for (const text of texts) {
    const file = ts.createSourceFile(
      'source.ts',
      text,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
    const declares = declarationName(file);
    const visit = (node: ts.Node): void => {
      if (
        declares !== null &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === declares
      ) {
        return;
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        written.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return written;
}
