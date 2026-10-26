#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Blank every comment, keeping line breaks; a `//` or `/*` inside a string or template is text. */
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    const close = text.startsWith('//', i) ? '\n' : text.startsWith('/*', i) ? '*/' : null;
    if (!close) {
      out += c;
      continue;
    }
    const stop = text.indexOf(close, i + 2);
    const to = stop === -1 ? text.length : close === '\n' ? stop : stop + 2;
    out += text.slice(i, to).replace(/[^\n]/g, ' ');
    i = to - 1;
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
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
]);

export function readsIn(rel, source) {
  const text = stripComments(source);
  const reads = [];
  for (const hit of text.matchAll(/\bprojects\.(repoPath|repo_path)\b/g)) {
    reads.push({ rel, line: lineOf(text, hit.index), how: `projects.${hit[1]}` });
  }
  const aliases = new Set();
  for (const hit of text.matchAll(
    /\b(?:from|join)\s+"?projects"?\s+(?:as\s+)?([a-z_][a-z0-9_]*)/gi,
  )) {
    if (!SQL_WORDS.has(hit[1].toLowerCase())) aliases.add(hit[1]);
  }
  for (const alias of aliases) {
    for (const hit of text.matchAll(new RegExp(`\\b${alias}\\.repo_path\\b`, 'g'))) {
      reads.push({ rel, line: lineOf(text, hit.index), how: `${alias}.repo_path (projects)` });
    }
  }
  return reads;
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
