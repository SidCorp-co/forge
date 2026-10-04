// What the module-shape rules judge a file against: packages/core/src/modules.json and the tables
// the schema files declare, read once per lint run.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredTables, kindOf, moduleOf, parseDeclaration } from '../lib/module-shape.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DECLARATION = 'packages/core/src/modules.json';
const SCHEMA_DIR = 'packages/core/src/db';

let cached = null;

/** The declaration, its table owners and the schema's tables; throws on a refused declaration. */
export function shape() {
  if (cached) return cached;
  const doc = JSON.parse(readFileSync(join(ROOT, DECLARATION), 'utf8'));
  const { faults, modules, owners } = parseDeclaration(doc);
  if (faults.length)
    throw new Error(`module-shape: ${DECLARATION} is refused:\n  ${faults.join('\n  ')}`);
  const schemaFiles = readdirSync(join(ROOT, SCHEMA_DIR))
    .filter((f) => /^schema[^/]*\.ts$/.test(f))
    .map((f) => `${SCHEMA_DIR}/${f}`);
  const tables = declaredTables(schemaFiles.map((f) => readFileSync(join(ROOT, f), 'utf8')));
  const bySql = new Map([...tables].map(([name, sql]) => [sql, name]));
  cached = { modules, owners, tables, bySql, schemaFiles: new Set(schemaFiles) };
  return cached;
}

/** The repo-relative path of a linted file, with forward slashes. */
export function repoPath(filename) {
  return relative(ROOT, filename).split(sep).join('/');
}

/** The module and kind a linted file belongs to. */
export function placeOf(filename) {
  const { modules } = shape();
  const file = repoPath(filename);
  const module = moduleOf(file, modules);
  return { file, module, kind: kindOf(module, modules) };
}
