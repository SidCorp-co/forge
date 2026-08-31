#!/usr/bin/env node

// Injected-doc mode-qualification gate.
//
// Guide bodies and mandatory facts reach every agent session on every project,
// and `pipelineConfig.mode` is per-project. Two rules over two surfaces:
//
//   R1  a status transition names the mode it means, when its target is
//       outside AUTONOMOUS_DRIVER_STATUSES
//   R2  a pipeline STEP named as the ACTOR of something the reader is told
//       about names it too — staged and autonomous share no step name
//
// Out of reach, each for its own reason, none of them "unwritten yet":
// whether the prose around a qualified claim is TRUE needs a reader who knows
// the domain; a status ladder with no backtick or arrow was probed 2026-08-31
// and occurs zero times, so the rule could not fail; and `projectFacts` live
// in the DATABASE while this runs in a CI job with node and nothing else —
// covering them means the same rule in TypeScript at the write boundary, a
// second copy of these regexes that no parity test can compare.
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
  steps: 'packages/contracts/src/pipeline-registry.ts',
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

// cm:guard derive the staged step names from the TOGGLE KEYS, never list them here. `REGISTRY_STEP_TOGGLE_KEYS` is what `pipelineConfig` actually switches, so a step added there without a toggle is a step no project can turn off — and a hand-copied list would let this gate go quiet about a step the fleet had already started running.
function stepVocabulary() {
  const toggles = read(SOURCES.steps);
  const m = /export const REGISTRY_STEP_TOGGLE_KEYS = \[([^\]]*)\]/.exec(toggles);
  if (m === null) throw new CannotRun(`${SOURCES.steps}: REGISTRY_STEP_TOGGLE_KEYS not found`);
  const staged = [...m[1].matchAll(/"auto([A-Z]\w*)"/g)].map((x) => x[1].toLowerCase());
  if (staged.length === 0) throw new CannotRun(`${SOURCES.steps}: no auto* toggle keys`);

  const drive = /export const AUTONOMOUS_JOB_TYPE[^=]*=\s*'([a-z_]+)'/.exec(read(SOURCES.constant));
  if (drive === null) throw new CannotRun(`${SOURCES.constant}: AUTONOMOUS_JOB_TYPE not found`);
  return [...staged, drive[1]];
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

    // cm:guard EACH rule fails closed on its own count. One shared "found nothing" check lets a botched R2 regex ride R1's non-zero total into a green build — which is exactly how a rule that matches nothing becomes indistinguishable from a rule that is satisfied.
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
  // cm:edge naming -> scripts/verify.mjs — that script reads capture group 1 of this line as the fail-closed scan count, so the SUM leads: with either rule's count in front, a surface that legitimately holds none of that one kind would read as an empty scope.
  console.log(
    `injected-doc-modes: ${checked + claims} mode-specific claim(s) — ${checked} transition, ${claims} step — across ${bodies} injected bodies, all mode-qualified`,
  );
  return 0;
}

process.exit(main());
