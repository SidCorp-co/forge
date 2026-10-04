// Type questions the module-shape rules ask the TypeScript checker, so a receiver or a table is
// recognised by what it is rather than by what it is called.

const DB_CLASSES = new Set(['PgDatabase', 'PgTransaction']);

function declaredInDrizzle(symbol) {
  return (symbol?.getDeclarations() ?? []).some((d) =>
    d.getSourceFile().fileName.includes('/drizzle-orm/'),
  );
}

/** True for a Drizzle Postgres database or transaction, under any name or alias. */
export function isDrizzleDb(type, checker, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) return type.types.some((t) => isDrizzleDb(t, checker, seen));
  const symbol = type.getSymbol();
  if (symbol && DB_CLASSES.has(symbol.getName()) && declaredInDrizzle(symbol)) return true;
  const target = type.target ?? type;
  if (!target.isClassOrInterface?.()) return false;
  return (checker.getBaseTypes(target) ?? []).some((b) => isDrizzleDb(b, checker, seen));
}

function literalProperty(type, name, checker) {
  const prop = checker.getPropertyOfType(type, name);
  if (!prop) return undefined;
  const t = checker.getTypeOfSymbol(prop);
  return t.isStringLiteral() ? t.value : null;
}

/**
 * The SQL names of the Drizzle tables a value's type is: one per table, `null` for a table whose
 * type does not carry its name (a `PgTable` parameter), and an empty list for anything else.
 */
export function tableNames(type, checker) {
  if (!type) return [];
  if (type.isUnion()) return type.types.flatMap((t) => tableNames(t, checker));
  const meta = checker.getPropertyOfType(type, '_');
  if (!meta) return [];
  const metaType = checker.getTypeOfSymbol(meta);
  if (literalProperty(metaType, 'brand', checker) !== 'Table') return [];
  return [literalProperty(metaType, 'name', checker) ?? null];
}
