// REQ-12 BC-18 (ISS-1175): an outbox event nobody consumes is not emitted. The two registries are
// read from their source with the TypeScript parser, never imported, so a value the parser cannot
// read is a refusal of the check rather than a list read as empty.

import ts from 'typescript';

/** The string elements of `const <name> = [...]`, or a sentence saying why they cannot be read. */
export function readEventTypes(file, source, name = 'OUTBOX_EVENT_TYPES') {
  const init = initializerOf(file, source, name);
  if (typeof init === 'string') return { unreadable: init };
  if (!ts.isArrayLiteralExpression(init))
    return { unreadable: `${name} in ${file} is not an array literal` };
  const types = [];
  for (const el of init.elements) {
    if (!ts.isStringLiteral(el))
      return { unreadable: `${name} in ${file} holds ${el.getText()}, not a string literal` };
    types.push(el.text);
  }
  return { types };
}

/** Each event type `const <name> = {...}` names, with how many consumers its list holds. */
export function readConsumerCounts(file, source, name = 'OUTBOX_CONSUMERS') {
  const init = initializerOf(file, source, name);
  if (typeof init === 'string') return { unreadable: init };
  if (!ts.isObjectLiteralExpression(init))
    return { unreadable: `${name} in ${file} is not an object literal` };
  const counts = new Map();
  for (const prop of init.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !(ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name))
    )
      return { unreadable: `${name} in ${file} holds ${prop.getText()}, not "type": [consumers]` };
    const list = unwrap(prop.initializer);
    if (!ts.isArrayLiteralExpression(list) || list.elements.some((e) => !ts.isStringLiteral(e)))
      return {
        unreadable: `${name}["${prop.name.text}"] in ${file} is not a list of consumer names`,
      };
    counts.set(prop.name.text, list.elements.length);
  }
  return { counts };
}

/** `OUTBOX_EVENT_UNCONSUMED <type>` for every registered type with no consumer, absent or `[]`. */
export function unconsumedFaults(types, counts) {
  return types.filter((t) => (counts.get(t) ?? 0) === 0).map((t) => `OUTBOX_EVENT_UNCONSUMED ${t}`);
}

function initializerOf(file, source, name) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer)
        return unwrap(d.initializer);
  }
  return `${file} declares no ${name}`;
}

/** `x as const satisfies T` and `(x)` read as `x`. */
function unwrap(node) {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n))
    n = n.expression;
  return n;
}
