#!/usr/bin/env node
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
