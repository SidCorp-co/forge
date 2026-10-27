#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launched } from './lib/entrypoint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'packages/core/src';
const READER = 'packages/core/src/lib/device-pool.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

/**
 * The project's checkout hint, by the one name no other column shares: `projects.repo_path_hint`,
 * `projects.repoPathHint` in Drizzle. Any letter case, so SQL written in capitals is the same name.
 */
export const HINT = /repo_?path_?hint/i;

/**
 * The files that may name the hint, each for a reason that is not a working directory. A working
 * directory is a device's (`runners.repoPath`), read through `readDeviceBinding` in READER — ISS-1236.
 * Inside core the hint keeps this name; only an answer that leaves core calls it `repoPath`
 * (`ANSWERED_AS_REPO_PATH`), and a read of that answer's `.repoPath` is one this search cannot see.
 */
export const DECLARED = new Map([
  ['packages/core/src/db/schema.ts', 'defines the column'],
  ['packages/core/src/projects/projections.ts', "answers it as the project's `repoPath` setting"],
  [
    'packages/core/src/projects/service.ts',
    "writes it when a project is created and reads it as the project's setting",
  ],
  ['packages/core/src/projects/routes.ts', "writes it from `PATCH /api/projects/:id`'s `repoPath`"],
  [
    'packages/core/src/mcp/tools/forge-projects.ts',
    "writes it from `forge_projects.update`'s `repoPath`",
  ],
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
    'packages/core/src/integrations/status-service.ts',
    "the git remote the integrations status shows, read on core's own host",
  ],
  [
    'packages/core/src/projects/agent-config-schema.ts',
    'names the column in the refusal of the retired `agentConfig.repoPath`; reads nothing',
  ],
  [
    'packages/core/src/mcp/tools/forge-config.ts',
    "answers it as `forge_config`'s `config.repoPath`",
  ],
  [
    'packages/core/src/projects/autonomous-contract.ts',
    'whether the project declares a repository (`declaresRepository`), from the readers that read it',
  ],
]);

/** The declared readers whose answers leave core carrying the hint under the API's name `repoPath`. */
export const ANSWERED_AS_REPO_PATH = [
  'packages/core/src/projects/projections.ts',
  'packages/core/src/projects/service.ts',
  'packages/core/src/projects/routes.ts',
  'packages/core/src/mcp/tools/forge-projects.ts',
  'packages/core/src/mcp/tools/forge-config.ts',
  'packages/core/src/projects/health-routes.ts',
];

function die(message) {
  console.error(`check-repo-path-readers: ${message}`);
  process.exit(2);
}

/** Every line of `source` that names the hint, as `{ rel, line, text }`. */
export function namesIn(rel, source) {
  const found = [];
  source.split('\n').forEach((text, i) => {
    if (HINT.test(text)) found.push({ rel, line: i + 1, text: text.trim() });
  });
  return found;
}

/**
 * What the rule refuses in `sources` (relative path → text): each line outside DECLARED that names
 * the hint, and each DECLARED file present that no longer names it.
 */
export function check(sources) {
  const reads = [...sources]
    .filter(([rel]) => !DECLARED.has(rel))
    .flatMap(([rel, text]) => namesIn(rel, text));
  const stale = [...DECLARED.keys()].filter(
    (rel) => sources.has(rel) && namesIn(rel, sources.get(rel)).length === 0,
  );
  return { reads, stale };
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
    if (/\.(test|fixture)\./.test(entry.name)) continue;
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
  const sources = new Map(files.map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
  if (namesIn('', sources.get('packages/core/src/db/schema.ts') ?? '').length === 0) {
    die('packages/core/src/db/schema.ts names no repo_path_hint, so this search finds nothing');
  }

  const { reads, stale } = check(sources);
  if (stale.length > 0) {
    console.error(
      `check-repo-path-readers: ${stale.length} declared reader(s) no longer name the hint — remove each from DECLARED:\n`,
    );
    for (const rel of stale) console.error(`  ${rel}`);
  }
  if (reads.length > 0) {
    console.error(
      `check-repo-path-readers: ${reads.length} line(s) name the project's checkout hint outside the declared readers:\n`,
    );
    for (const r of reads) console.error(`  ${r.rel}:${r.line} — ${r.text}`);
    console.error(
      `\nA working directory is the device's, never the project's (ISS-1236): every box keeps the\n` +
        `project at its own path, so the project's hint names some other box. Take it from\n` +
        `\`readDeviceBinding\` in ${READER}, which refuses a device the project never bound.\n` +
        `If this file needs the project's own setting for another reason, add it to DECLARED in\n` +
        `scripts/check-repo-path-readers.mjs with that reason.`,
    );
  }
  if (reads.length > 0 || stale.length > 0) process.exit(1);

  console.log(
    `repo-path-readers: ${files.length} file(s) scanned, ${DECLARED.size} declared reader(s)`,
  );
}

if (launched(import.meta.url)) main();
