#!/usr/bin/env node

// Injected-doc mode-qualification gate.
//
// Guide bodies and mandatory facts are injected into every agent session on
// every project, and `pipelineConfig.mode` is per-project. One rule over two
// surfaces:
//
//   R1  a status transition in an always-injected doc names the mode it means,
//       whenever its target is outside AUTONOMOUS_DRIVER_STATUSES
//
// What this CANNOT see: whether the prose around a qualified transition is
// true, a mode-specific claim carrying no transition (`the plan step declares
// the edges` — autonomous has no plan step), a status ladder written without
// backticks or arrows, and anything in a project's own `projectFacts`, which
// live in the database and never reach CI.
//
// Exit codes: 0 clean, 1 violations found, 2 could not run.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkSurface, extractBodies } from './lib/injected-doc-modes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  constant: 'packages/core/src/pipeline/autonomous-mode.ts',
  schema: 'packages/core/src/db/schema.ts',
};

// cm:guard the fact openers must keep matching `export const` as well as `render:`, because the tier-1 MANDATORY text — the only text injected into every job rather than fetched on demand — reaches the registry through `render: () => PIPELINE_RULES_TEXT` and lives in a top-level const; matching `render:` alone extracted 12 bodies and read green while the two `→ approved` claims in that constant went unseen.
const SURFACES = [
  { file: 'packages/core/src/guides/registry.ts', openers: ['body:'] },
  {
    file: 'packages/core/src/prompt/facts/registry.ts',
    openers: ['render: \\([^)]*\\) =>', '(?:export )?const \\w+ ='],
  },
];

class CannotRun extends Error {}

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch (err) {
    throw new CannotRun(`${rel}: ${err.message}`);
  }
}

function arrayLiterals(src, declRe, rel, what) {
  const m = declRe.exec(src);
  if (m === null) throw new CannotRun(`${rel}: ${what} not found`);
  const out = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (out.length === 0) throw new CannotRun(`${rel}: ${what} is empty`);
  return out;
}

function main() {
  let violations = [];
  let checked = 0;
  let bodies = 0;
  let driverStatuses;
  try {
    const allStatuses = arrayLiterals(
      read(SOURCES.schema),
      /export const issueStatuses = \[([^\]]*)\]/,
      SOURCES.schema,
      'issueStatuses',
    );
    driverStatuses = arrayLiterals(
      read(SOURCES.constant),
      /export const AUTONOMOUS_DRIVER_STATUSES[^=]*=\s*\[([^\]]*)\]/,
      SOURCES.constant,
      'AUTONOMOUS_DRIVER_STATUSES',
    );

    for (const surface of SURFACES) {
      const extracted = extractBodies(read(surface.file), surface.openers);
      if (extracted.length === 0) {
        throw new CannotRun(`${surface.file}: no ${surface.openers.join('/')} bodies extracted`);
      }
      bodies += extracted.length;
      const r = checkSurface(
        { file: surface.file, bodies: extracted },
        allStatuses,
        driverStatuses,
      );
      violations = violations.concat(r.violations);
      checked += r.transitionsChecked;
    }

    if (checked === 0) {
      throw new CannotRun('0 transitions found across every surface — the extraction is broken');
    }
  } catch (err) {
    if (err instanceof CannotRun) {
      console.error(`injected-doc-modes: could not run — ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (violations.length > 0) {
    for (const v of violations) {
      const t = v.from ? `\`${v.from}\` → \`${v.to}\`` : `→ \`${v.to}\``;
      console.error(`${v.file}:${v.line}: ${t} names no pipeline mode`);
      console.error(`    ${v.text.slice(0, 140)}`);
    }
    console.error(
      `\ninjected-doc-modes: ${violations.length} unqualified transition(s) across ${bodies} injected bodies`,
    );
    console.error(
      `The autonomous driver writes only ${driverStatuses.map((s) => `\`${s}\``).join(', ')}, and these docs reach every project.`,
    );
    console.error(
      'Name the mode on the line (or in its table row) that the transition belongs to.',
    );
    return 1;
  }
  console.log(
    `injected-doc-modes: ${checked} transition(s) across ${bodies} injected bodies, all mode-qualified`,
  );
  return 0;
}

process.exit(main());
