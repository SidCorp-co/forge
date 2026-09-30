#!/usr/bin/env node

// The published contracts are the code's, or this is red.
//
// packages/core/contracts/ holds two artifacts a differ reads: forge-api (OpenAPI 3.1, every
// route packages/core/src/index.ts mounts, inputs read off the zod validators) and forge-mcp
// (the tools tools/list serves). Both are generated from the running app, and nothing but this
// check makes the committed bytes follow the code: a route added, removed or re-validated
// without regenerating is a contract change no reader can see. So this regenerates into a
// scratch directory and names every route or tool whose committed entry differs.
//
// A route or tool the generator cannot describe is its refusal, red here rather than omitted.
//
// Exit codes: 0 committed = generated, 1 drift or a refusal, 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, artifactDrift, MCP, memberCount } from './lib/api-contracts.mjs';
import { absentPrerequisites, couldNotStart, remedyLines } from './lib/prerequisite.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const GENERATOR = join(CORE, 'src', 'api-contract', 'generate.ts');
const REGENERATE = 'pnpm --filter @forge/core contracts:generate';
const ARTIFACTS = [
  { spec: API, file: 'forge-api.openapi.json' },
  { spec: MCP, file: 'forge-mcp.tools.json' },
];

function die(message) {
  console.error(`check-api-contracts: ${message}`);
  process.exit(2);
}

if (process.argv.length > 2) die(`takes no arguments, got: ${process.argv.slice(2).join(' ')}`);

const missing = absentPrerequisites(ROOT, ['deps', 'observability-build', 'contracts-build']);
if (missing.length > 0) die(`could not run — ${remedyLines(missing)[0]}`);
if (!existsSync(GENERATOR)) die('packages/core/src/api-contract/generate.ts not found');

// cm:why under node_modules because verify runs checks concurrently, and it is the one place in
// the package every other checker's tree walk skips.
const out = mkdtempSync(join(CORE, 'node_modules', '.forge-api-contracts-'));
let result;
const generated = {};
try {
  result = spawnSync(TSX, [GENERATOR, '--out', out], {
    cwd: CORE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const { file } of ARTIFACTS) {
    const path = join(out, file);
    generated[file] = existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (couldNotStart(result))
  die(`${TSX} is not executable here — run: pnpm install --frozen-lockfile`);
if (result.error) die(`could not run the generator: ${result.error.message}`);
if (result.status === 1) {
  console.error(`${result.stderr}`.trimEnd());
  console.error(
    '\ncheck-api-contracts: the generator refused the routes or tools above. Each is mounted\n' +
      'and cannot be described, and a contract that left it out would read as complete.\n',
  );
  process.exit(1);
}
if (result.status !== 0 || ARTIFACTS.some(({ file }) => generated[file] === null)) {
  console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd());
  die(`the generator exited ${result.status} without writing both artifacts`);
}

const findings = [];
const counts = [];
for (const { spec, file } of ARTIFACTS) {
  const committedPath = join(CORE, 'contracts', file);
  const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : null;
  const drift = artifactDrift(spec, committed, generated[file]);
  if (drift.unusable) die(drift.unusable);
  findings.push(...drift.findings);
  const count = memberCount(spec, generated[file]);
  if (count === null) die(`the generated ${spec.label} is not JSON`);
  counts.push(`${count} ${spec.kind}(s)`);
}

console.log(`api-contracts: ${counts.join(' · ')} compared`);
if (findings.length === 0) process.exit(0);

console.error(`\ncheck-api-contracts: ${findings.length} difference(s) from the code:`);
for (const finding of findings) console.error(`  ${finding}`);
console.error(
  `\nThe committed contract is what a differ reads, so it has to be what the code serves.\n` +
    `If the change is intended, regenerate and commit both files:\n  ${REGENERATE}\n`,
);
process.exit(1);
