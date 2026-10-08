#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './lib/debt-ratchet.mjs';
import { skillFaults } from './lib/skill-frontmatter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function die(message) {
  console.error(`check-skill-frontmatter: ${message}`);
  process.exit(2);
}

// `--all` is the form verify runs. `--root <dir>` reads that directory of skills instead of the
// declared ones, which is how a test plants a skill without touching the tree.
const args = process.argv.slice(2);
const roots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') continue;
  if (args[i] === '--root' && args[i + 1]) {
    roots.push(resolve(args[++i]));
    continue;
  }
  die('usage: check-skill-frontmatter.mjs [--all | --root <directory of skills>]...');
}

if (roots.length === 0) {
  const { manifest, error } = readManifest(ROOT);
  if (error) die(error);
  const declared = manifest?.checkers?.['skill-frontmatter']?.roots;
  if (!Array.isArray(declared) || declared.length === 0) {
    die(
      '.forge/conformance.json declares no checkers["skill-frontmatter"].roots — nothing would be measured',
    );
  }
  for (const rel of declared) roots.push(join(ROOT, rel));
}

let scanned = 0;
const offences = [];
for (const root of roots) {
  if (!existsSync(root)) die(`${root} does not exist — the skills it names are not being read`);
  const shown = (path) => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path);
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'SKILL.md');
    scanned++;
    if (!existsSync(file)) {
      offences.push({
        file: shown(file),
        field: 'file',
        rule: 'the directory holds no SKILL.md, so a session is never offered a skill from it',
        measured: 'absent',
        limit: 'SKILL.md',
      });
      continue;
    }
    for (const fault of skillFaults(readFileSync(file, 'utf8'), entry.name)) {
      offences.push({ file: shown(file), ...fault });
    }
  }
}

if (scanned === 0) {
  die(
    `no skill directory under ${roots.join(', ')} — the declared roots hold nothing to measure, ` +
      'or this checker is not reading what it thinks it is',
  );
}

if (offences.length === 0) {
  console.log(`skill-frontmatter: ${scanned} skill(s) scanned`);
  process.exit(0);
}

console.error(`skill-frontmatter: ${offences.length} fault(s) in ${scanned} skill(s) scanned\n`);
for (const o of offences) {
  console.error(`  ${o.file}  ${o.field}  ${o.rule}`);
  console.error(`    measured: ${o.measured}    limit: ${o.limit}\n`);
}
console.error(
  'An installer that enforces the Agent Skills spec rejects such a skill whole and says nothing the\n' +
    'build sees, so it is never offered to a session. This refuses by name and changes nothing: a\n' +
    'description is shortened, a name corrected, by the person who owns the skill.',
);
process.exit(1);
