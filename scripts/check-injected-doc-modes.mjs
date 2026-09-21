#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkSurface, extractBodies } from './lib/injected-doc-modes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  constant: 'packages/core/src/pipeline/autonomous-mode.ts',
  schema: 'packages/core/src/db/schema.ts',
  steps: 'packages/core/src/pipeline/registry.ts',
};

const SURFACES = [
  { file: 'packages/core/src/guides/registry.ts', openers: ['body:'] },
  { file: 'packages/core/src/guides/conformance-guide.ts', openers: ['body:'] },
  { file: 'packages/core/src/assistant/prompt/base.ts', openers: ['text:'] },
  { file: 'packages/core/src/assistant/prompt/tools.ts', openers: ['text:'] },
  {
    file: 'packages/core/src/prompt/facts/registry.ts',
    openers: ['render: \\([^)]*\\) =>', '(?:export )?const \\w+ ='],
  },
  {
    file: 'packages/core/src/prompt/facts/drive-rules.ts',
    openers: ['(?:export )?const \\w+ ='],
  },
];

const COMPOSED_ONLY = [
  { file: 'packages/core/src/guides/assistant-method-guide.ts', openers: ['body:'] },
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

const GATE_BYPASSING_JOB_TYPES = ['pm', 'custom'];

function stepVocabulary() {
  const all = arrayLiterals(
    read(SOURCES.schema),
    /export const jobTypes = \[([^\]]*)\]/,
    SOURCES.schema,
    'jobTypes',
  );
  const caps = read(SOURCES.steps);
  const m = /'claude-code':\s*\[([^\]]*)\]/.exec(caps);
  if (m === null)
    throw new CannotRun(`${SOURCES.steps}: RUNNER_CAPABILITIES claude-code not found`);
  const claimable = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (claimable.length === 0) throw new CannotRun(`${SOURCES.steps}: no claimable job types`);

  const retired = all.filter(
    (t) => !claimable.includes(t) && !GATE_BYPASSING_JOB_TYPES.includes(t),
  );
  if (retired.length === 0) throw new CannotRun(`${SOURCES.schema}: no retired job types`);

  const drive = /export const AUTONOMOUS_JOB_TYPE[^=]*=\s*'([a-z_]+)'/.exec(read(SOURCES.constant));
  if (drive === null) throw new CannotRun(`${SOURCES.constant}: AUTONOMOUS_JOB_TYPE not found`);
  return [...retired, drive[1]];
}

function main() {
  let violations = [];
  let checked = 0;
  let claims = 0;
  let bodies = 0;
  let driverStatuses;
  let stepNames;
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

    stepNames = stepVocabulary();

    for (const composed of COMPOSED_ONLY) {
      const stray = extractBodies(read(composed.file), composed.openers);
      if (stray.length > 0) {
        throw new CannotRun(
          `${composed.file}: carries ${stray.length} ${composed.openers.join('/')} literal(s), but its text must be composed from the layers this gate reads — move the text into packages/core/src/assistant/prompt/ or add this file back to SURFACES`,
        );
      }
    }

    for (const surface of SURFACES) {
      const extracted = extractBodies(read(surface.file), surface.openers);
      if (extracted.length === 0) {
        throw new CannotRun(`${surface.file}: no ${surface.openers.join('/')} bodies extracted`);
      }
      bodies += extracted.length;
      const r = checkSurface(
        { file: surface.file, bodies: extracted },
        {
          allStatuses,
          driverStatuses,
          stepNames,
        },
      );
      violations = violations.concat(r.violations);
      checked += r.transitionsChecked;
      claims += r.stepClaimsChecked;
    }

    if (checked === 0) {
      throw new CannotRun('0 transitions found across every surface — R1 extraction is broken');
    }
    if (claims === 0) {
      throw new CannotRun('0 step claims found across every surface — R2 extraction is broken');
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
      const what =
        v.rule === 'R1'
          ? `${v.from ? `\`${v.from}\` → ` : '→ '}\`${v.to}\` names no pipeline mode`
          : `\`${v.steps}\` acts as a step, and names no pipeline mode`;
      console.error(`${v.file}:${v.line}: [${v.rule}] ${what}`);
      console.error(`    ${v.text.slice(0, 140)}`);
    }
    const r1 = violations.filter((v) => v.rule === 'R1').length;
    console.error(
      `\ninjected-doc-modes: ${r1} unqualified transition(s) and ${violations.length - r1} unqualified step claim(s) across ${bodies} injected bodies`,
    );
    console.error(
      `The autonomous driver writes only ${driverStatuses.map((s) => `\`${s}\``).join(', ')} and runs no step but \`${stepNames[stepNames.length - 1]}\`, and these docs reach every project.`,
    );
    console.error('Name the mode the claim belongs to, on the line or in its table row.');
    return 1;
  }
  console.log(
    `injected-doc-modes: ${checked + claims} mode-specific claim(s) — ${checked} transition, ${claims} step — across ${bodies} injected bodies, all mode-qualified`,
  );
  return 0;
}

process.exit(main());
