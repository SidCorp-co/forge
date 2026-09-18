#!/usr/bin/env node
// The preflight the `archmap` CI job runs before `./.forge/archmap/archmap check`.
//
// archmap refuses an unresolvable graph with exit 2, which is right. What it cannot
// do is say WHY: this repo has no `go.mod`, so archmap's Go provider returns an
// empty-but-ok graph, `buildScope` never reaches the branch that prints the
// TypeScript provider's reason, and every failure of that provider arrives as
// `scope matched no files (.)` — a sentence about this repo's scope. On 2026-09-18
// that sentence was the only thing four closed npm dependency-group PRs ever said
// about a renamed file in dependency-cruiser 18.3.0 (ISS-1098).
//
// So the naming has to happen before archmap speaks, and it has to happen HERE as
// well as in `pnpm verify`: the CI job runs the vendored binary directly, and
// Outcome 2 of ISS-1098 is that a reader of CI can tell the two apart.
//
// cm:edge naming -> scripts/lib/prerequisite.mjs — the same table `verify.mjs` and
//   `conformance-audit.mjs` read, so all three refuse on one definition.
// cm:guard exit 2, never 1. "The gate could not run" and "the code violates a
//   contract" are different answers and the workflow reads them differently — the
//   archmap job's own comment says never to read 2 as a pass.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absentPrerequisites, remedyLines } from './lib/prerequisite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDS = ['deps', 'archmap-resolver', 'observability-build'];

const missing = absentPrerequisites(ROOT, NEEDS);
if (missing.length === 0) {
  process.stdout.write(`check-archmap-ready: ${NEEDS.length} prerequisites present\n`);
  process.exit(0);
}

process.stderr.write('check-archmap-ready: archmap cannot run in this checkout, so the\n');
process.stderr.write('check-archmap-ready: architecture gate did NOT run. It has not passed.\n');
for (const line of remedyLines(missing)) process.stderr.write(`check-archmap-ready:   - ${line}\n`);
process.exit(2);
