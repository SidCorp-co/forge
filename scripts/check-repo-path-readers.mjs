#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'packages/core/src';
const READER = 'packages/core/src/lib/device-pool.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'drizzle']);

/**
 * The files that may read `projects.repoPath`, each for a reason that is not a working directory.
 * A working directory is a device's (`runners.repoPath`), read through `readDeviceBinding` in
 * READER — ISS-1236.
 */
export const DECLARED = new Map([
  ['packages/core/src/db/schema.ts', 'defines the column'],
  [
    'packages/core/src/projects/projections.ts',
    "the project's own setting, as its reads answer it",
  ],
  ['packages/core/src/projects/service.ts', "the project's own setting, as its reads answer it"],
  ['packages/core/src/projects/health-routes.ts', "the project's own setting, shown on its row"],
  [
    'packages/core/src/devices/routes.ts',
    'the default offered beside a device assignment, which is what binding a device starts from',
  ],
  [
    'packages/core/src/release-batch/readiness.ts',
    'whether the project declares a repository (`declaresRepository`)',
  ],
  [
    'packages/core/src/prompt/facts/resolve.ts',
    'whether the project declares a repository (`declaresRepository`)',
  ],
  [
    'packages/core/src/projects/agent-config-schema.ts',
    'names the column in the refusal of the retired `agentConfig.repoPath`; reads nothing',
  ],
  [
    'packages/core/src/integrations/status-service.ts',
    "the git remote the integrations status shows, read on core's own host",
  ],
]);

function die(message) {
  console.error(`check-repo-path-readers: ${message}`);
  process.exit(2);
}

const SQL_WORDS = new Set([
  'on',
  'where',
  'join',
  'left',
  'inner',
  'using',
  'group',
  'order',
  'limit',
  'set',
]);

const NAMES_PROJECTS =
  /\b(?:from|join|update|into)\s+"?projects"?(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;

const isProjects = (node) => node && ts.isIdentifier(node) && node.text === 'projects';
const calls = (node, names) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  names.includes(node.expression.name.text);

/** A drizzle chain under `node` that started from `update(projects)` or `insert(projects)`. */
function writesProjects(node) {
  for (let at = node; at; ) {
    if (calls(at, ['update', 'insert'])) return isProjects(at.arguments[0]);
    if (ts.isCallExpression(at) || ts.isPropertyAccessExpression(at)) at = at.expression;
    else if (ts.isAwaitExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
    else return false;
  }
  return false;
}

/**
 * Whether this node hands the file every column of projects, `repoPath` among them: a whole-row
 * select, the relational query, an argument-less `returning()` after a write, or the column map.
 */
function wholeRow(node) {
  if (calls(node, ['from']) && isProjects(node.arguments[0])) {
    const source = node.expression.expression;
    return calls(source, ['select', 'selectDistinct']) && source.arguments.length === 0;
  }
  if (calls(node, ['findFirst', 'findMany'])) {
    const table = node.expression.expression;
    return (
      ts.isPropertyAccessExpression(table) &&
      table.name.text === 'projects' &&
      ts.isPropertyAccessExpression(table.expression) &&
      table.expression.name.text === 'query'
    );
  }
  if (calls(node, ['returning']) && node.arguments.length === 0) {
    return writesProjects(node.expression.expression);
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'getTableColumns' &&
    isProjects(node.arguments[0])
  );
}

/** A string or template's own text at its own offset; a template's `${...}` is blanked. */
function literalText(node, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { at: node.getStart(), body: source.slice(node.getStart(), node.end) };
  }
  if (!ts.isTemplateExpression(node)) return null;
  const at = node.getStart();
  let body = source.slice(at, node.end);
  for (const span of node.templateSpans) {
    const from = span.expression.getFullStart() - 2 - at;
    const to = span.literal.getStart() + 1 - at;
    // `${projects}` is the table itself, interpolated by drizzle: kept as its name, so the text
    // still says which table it reads.
    const kept = isProjects(span.expression)
      ? 'projects'.padStart(to - from)
      : body.slice(from, to).replace(/[^\n]/g, ' ');
    body = body.slice(0, from) + kept + body.slice(to);
  }
  return { at, body };
}

/** The reads of projects' repo path in an SQL text, each at its offset in that text. */
function sqlReads(body) {
  const reads = [];
  const aliases = new Set();
  let named = false;
  for (const hit of body.matchAll(NAMES_PROJECTS)) {
    named = true;
    if (hit[1] && !SQL_WORDS.has(hit[1].toLowerCase())) aliases.add(hit[1]);
  }
  aliases.add('projects');
  if (!named) {
    for (const hit of body.matchAll(/\bprojects\.(?:repo_path\b|\*)/g)) {
      reads.push({
        index: hit.index,
        how:
          hit[0] === 'projects.*' ? 'a whole row of projects (projects.*)' : 'projects.repo_path',
      });
    }
    return reads;
  }
  for (const hit of body.matchAll(/(?<![\w."])"?repo_path\b/g)) {
    reads.push({ index: hit.index, how: 'repo_path (in SQL over projects)' });
  }
  // `SELECT *` takes projects' columns only where its own FROM clause, up to the next SELECT,
  // names the table; `SELECT * FROM aged` over a CTE takes whatever the CTE chose.
  for (const hit of body.matchAll(/\bselect\s+(?:distinct\s+)?\*(?:(?!\bselect\b)[\s\S])*/gi)) {
    if (new RegExp(NAMES_PROJECTS.source, 'i').test(hit[0])) {
      reads.push({ index: hit.index, how: 'a whole row of projects (SELECT *)' });
    }
  }
  for (const alias of aliases) {
    for (const hit of body.matchAll(new RegExp(`\\b${alias}\\.repo_path\\b`, 'g'))) {
      reads.push({
        index: hit.index,
        how: alias === 'projects' ? 'projects.repo_path' : `${alias}.repo_path (projects)`,
      });
    }
    for (const hit of body.matchAll(new RegExp(`\\b${alias}\\.\\*`, 'g'))) {
      reads.push({ index: hit.index, how: `a whole row of projects (${alias}.*)` });
    }
  }
  return reads;
}

/**
 * Every read of `projects.repoPath` in one source file, parsed rather than pattern-matched so a
 * comment, a regular expression or a string holding a quote cannot hide what follows it.
 */
export function readsIn(rel, source) {
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads = [];
  const at = (pos, how) =>
    reads.push({ rel, line: file.getLineAndCharacterOfPosition(pos).line + 1, how, pos });
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isProjects(node.expression) &&
      (node.name.text === 'repoPath' || node.name.text === 'repo_path')
    ) {
      at(node.getStart(), `projects.${node.name.text}`);
    }
    if (wholeRow(node)) {
      const name = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
      at(name ? node.expression.name.getStart() : node.getStart(), 'a whole row of projects');
    }
    const literal = literalText(node, source);
    if (literal) for (const r of sqlReads(literal.body)) at(literal.at + r.index, r.how);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads.sort((a, b) => a.pos - b.pos).map(({ pos: _pos, ...r }) => r);
}

function walk(rel, acc) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, acc);
      continue;
    }
    if (!/\.ts$/.test(entry.name)) continue;
    if (/\.(test|fixture)\.ts$/.test(entry.name) || /\.fixture\./.test(entry.name)) continue;
    acc.push(path);
  }
  return acc;
}

function main() {
  if (process.argv[2] !== '--all')
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  if (!existsSync(join(ROOT, READER))) {
    die(`${READER} is not there, so nothing reads a device's binding and this rule cannot hold`);
  }
  const gone = [...DECLARED.keys()].filter((rel) => !existsSync(join(ROOT, rel)));
  if (gone.length > 0) {
    die(`a declared reader no longer exists — remove it from DECLARED: ${gone.join(', ')}`);
  }

  const files = walk(SOURCE, []);
  if (files.length === 0) die(`no source files found under ${SOURCE}`);

  const reads = files
    .filter((rel) => !DECLARED.has(rel))
    .flatMap((rel) => readsIn(rel, readFileSync(join(ROOT, rel), 'utf8')));

  if (reads.length > 0) {
    console.error(
      `check-repo-path-readers: ${reads.length} read(s) of projects.repoPath outside the declared readers:\n`,
    );
    for (const r of reads) console.error(`  ${r.rel}:${r.line} — ${r.how}`);
    console.error(
      `\nA working directory is the device's, never the project's (ISS-1236): every box keeps the\n` +
        `project at its own path, so the project's value names some other box. Take it from\n` +
        `\`readDeviceBinding\` in ${READER}, which refuses a device the project never bound.\n` +
        `If this file reads the project's own setting for another reason, add it to DECLARED in\n` +
        `scripts/check-repo-path-readers.mjs with that reason.`,
    );
    process.exit(1);
  }

  console.log(
    `repo-path-readers: ${files.length} file(s) scanned, ${DECLARED.size} declared reader(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
