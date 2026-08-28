#!/usr/bin/env node

// Autonomous transition-standard gate.
//
// The driver writes a KERNEL status. `needs_human` / `done` / `running` are render
// labels from packages/contracts/src/issue-vocabulary.ts and nothing on the write
// path translates them, so a surface that instructs one hands the agent a value
// `forge_issues` rejects. Two static rules over three files:
//
//   R1  the skill's "Statuses you may write" table == AUTONOMOUS_DRIVER_STATUSES
//   R2  no bundled skill names a render label as a status to write
//
// What this CANNOT see: what an agent actually wrote at runtime. That lives in
// `activity_log` and CI has no database. This gate holds the specification only.
//
// Exit codes: 0 clean, 1 violations found, 2 could not run.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  constant: 'packages/core/src/pipeline/autonomous-mode.ts',
  skill: 'packages/runner/skills/forge-drive/SKILL.md',
  vocabulary: 'packages/contracts/src/issue-vocabulary.ts',
  schema: 'packages/core/src/db/schema.ts',
};

// cm:guard R2 walks the WHOLE bundled tree, not just forge-drive. The driver spawns forge-understand, forge-plan, forge-review and forge-ship as sub-agents and each of them writes status too — scoped to forge-drive this checker read green while `needs_human` / `done` / `running` sat in two of the other four.
const SKILL_ROOT = 'packages/runner/skills';

class CannotRun extends Error {}

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch (err) {
    throw new CannotRun(`${rel}: ${err.message}`);
  }
}

function block(text, startRe, rel, what) {
  const start = text.search(startRe);
  if (start < 0) throw new CannotRun(`${rel}: ${what} not found`);
  return text.slice(start);
}

function arrayLiterals(body, rel, what) {
  const end = body.indexOf(']');
  if (end < 0) throw new CannotRun(`${rel}: ${what} is not closed`);
  return [...body.slice(0, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function parseConstant(text) {
  const decl = text.match(/export const AUTONOMOUS_DRIVER_STATUSES[^=]*=\s*\[([^\]]*)\]/);
  if (!decl) throw new CannotRun(`${SOURCES.constant}: AUTONOMOUS_DRIVER_STATUSES not found`);
  return [...decl[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function parseFirstColumn(text, startRe, rel, what) {
  const body = block(text, startRe, rel, what);
  const out = [];
  let seenHeader = false;
  for (const line of body.split('\n').slice(1)) {
    const row = line.match(/^\|\s*`([a-z_]+)`\s*\|/);
    if (row) {
      out.push(row[1]);
      seenHeader = true;
      continue;
    }
    if (seenHeader && !line.startsWith('|')) break;
  }
  if (out.length === 0) throw new CannotRun(`${rel}: ${what} has no rows`);
  return out;
}

// cm:edge contract -> packages/contracts/src/issue-vocabulary.ts — the label set is read from that file, never restated here, so adding a label there puts it under R2 the same day
function parseLabels(text) {
  const body = block(text, /export const LABEL_TO_KERNEL/, SOURCES.vocabulary, 'LABEL_TO_KERNEL');
  const end = body.indexOf('};');
  if (end < 0) throw new CannotRun(`${SOURCES.vocabulary}: LABEL_TO_KERNEL is not closed`);
  return [...body.slice(0, end).matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
}

function compare(actual, expected, rel, what, violations) {
  const missing = expected.filter((s) => !actual.includes(s));
  const extra = actual.filter((s) => !expected.includes(s));
  for (const s of missing) {
    violations.push(`${rel}: ${what} omits \`${s}\`, which AUTONOMOUS_DRIVER_STATUSES declares`);
  }
  for (const s of extra) {
    violations.push(`${rel}: ${what} lists \`${s}\`, which AUTONOMOUS_DRIVER_STATUSES does not`);
  }
}

// cm:guard R2 is scoped to the bundled skills — the INSTRUCTION surfaces — and must never be widened tree-wide: a page that documents the render labels names every one of them on purpose, and a tree-wide scan flags the explanation as the violation.
function checkLabels(text, rel, labels, kernelStatuses, violations) {
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const label of labels) {
      if (kernelStatuses.includes(label)) continue;
      if (!line.includes(`\`${label}\``)) continue;
      violations.push(
        `${rel}:${i + 1}: instructs \`${label}\`, a render label — the write API takes kernel statuses only`,
      );
    }
  }
}

function bundledSkills() {
  let entries;
  try {
    entries = readdirSync(resolve(ROOT, SKILL_ROOT), { withFileTypes: true });
  } catch (err) {
    throw new CannotRun(`${SKILL_ROOT}: ${err.message}`);
  }
  const found = entries
    .filter((e) => e.isDirectory())
    .map((e) => `${SKILL_ROOT}/${e.name}/SKILL.md`);
  if (found.length === 0) throw new CannotRun(`${SKILL_ROOT}: no bundled skills`);
  return found;
}

function main() {
  const violations = [];
  let expected;
  let labels;
  let kernelStatuses;
  try {
    const constantSrc = read(SOURCES.constant);
    expected = parseConstant(constantSrc);
    labels = parseLabels(read(SOURCES.vocabulary));

    kernelStatuses = arrayLiterals(
      block(
        read(SOURCES.schema),
        /export const issueStatuses = \[/,
        SOURCES.schema,
        'issueStatuses',
      ),
      SOURCES.schema,
      'issueStatuses',
    );

    const unknown = expected.filter((s) => !kernelStatuses.includes(s));
    if (unknown.length > 0) {
      violations.push(
        `${SOURCES.constant}: AUTONOMOUS_DRIVER_STATUSES names ${unknown.map((s) => `\`${s}\``).join(', ')}, absent from the issueStatuses enum`,
      );
    }

    for (const rel of bundledSkills()) {
      checkLabels(read(rel), rel, labels, kernelStatuses, violations);
    }

    const skillSrc = read(SOURCES.skill);
    compare(
      parseFirstColumn(skillSrc, /^## Statuses you may write/m, SOURCES.skill, 'the status table'),
      expected,
      SOURCES.skill,
      'the status table',
      violations,
    );
  } catch (err) {
    if (err instanceof CannotRun) {
      console.error(`autonomous-transitions: could not run — ${err.message}`);
      return 2;
    }
    throw err;
  }

  const scanned = new Set([...Object.keys(SOURCES).map((k) => SOURCES[k]), ...bundledSkills()])
    .size;
  if (violations.length > 0) {
    for (const v of violations) console.error(v);
    console.error(
      `\nautonomous-transitions: ${violations.length} violation(s) across ${scanned} files`,
    );
    console.error(
      'The only declaration of the standard is AUTONOMOUS_DRIVER_STATUSES in packages/core/src/pipeline/autonomous-mode.ts.',
    );
    return 1;
  }
  console.log(
    `autonomous-transitions: ${expected.length} driver status(es) agree across ${scanned} files`,
  );
  return 0;
}

process.exit(main());
