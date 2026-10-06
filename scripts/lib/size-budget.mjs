import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { baseRef } from './base-branch.mjs';
import { fileTotal } from './debt-ratchet.mjs';
import { gitOut } from './gate.mjs';

/** One scope's biome JSON report, or `{error}` naming why biome could not give one. */
export function biomeReport(root, scope) {
  const cwd = join(root, scope.cwd);
  if (!existsSync(cwd)) return { error: `scope directory missing: ${scope.cwd}` };
  let stdout;
  try {
    stdout = execFileSync(
      'npx',
      ['biome', ...scope.args, '--reporter=json', '--max-diagnostics=5000'],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch (err) {
    stdout = err.stdout;
    if (!stdout) return { error: `biome produced no output in ${scope.cwd}: ${err.message}` };
  }
  try {
    return { cwd, report: JSON.parse(stdout) };
  } catch {
    return { error: `biome output in ${scope.cwd} was not JSON` };
  }
}

export const SIZE_RULES = new Set([
  'lint/style/noExcessiveLinesPerFile',
  'lint/complexity/noExcessiveLinesPerFunction',
]);

/**
 * Compile one scope's `drain` declaration into a predicate over repo-relative paths.
 *
 * Returns null when the scope declares no drain, which leaves it freeze-only.
 */
export function drainMatcher(scope) {
  const d = scope?.drain;
  if (d === undefined || d === null) return null;
  if (!d.include) throw new Error(`scope ${scope.cwd}: drain declares no include pattern`);
  const include = new RegExp(d.include);
  const exclude = d.exclude ? new RegExp(d.exclude) : null;
  return (file) => include.test(file) && !exclude?.test(file);
}

/**
 * Drain: a changed drainable file must come back strictly lower than its baseline, its file and
 * longest-function line counts summed.
 *
 * @param measured  `{path: {fileLines, maxFunctionLines}}` for the whole scope set
 * @param baseline  the same shape, as frozen
 * @param changed   repo-relative paths in this branch's delta
 * @param renamed   Map<newPath, oldPath> for paths git detected as renames
 * @param matchers  the non-null results of drainMatcher, one per scope
 */
export function drainFaults({ measured, baseline, changed, renamed, matchers }) {
  if (matchers.length === 0) return [];
  const faults = [];
  for (const file of changed) {
    if (!matchers.some((m) => m(file))) continue;
    const now = fileTotal(measured[file]);
    const from = renamed.get(file);
    if (from !== undefined) {
      const carried = fileTotal(baseline[from]);
      if (now > carried) {
        faults.push({
          file,
          reasons: [
            `renamed from ${from} carrying ${carried} line(s) over budget, now ${now} — a move may not add debt`,
          ],
        });
      }
      continue;
    }
    const was = fileTotal(baseline[file]);
    if (was === 0) {
      if (now > 0) {
        faults.push({
          file,
          reasons: [
            `${now} line(s) over budget in a file frozen at 0 — a file at zero stays at zero`,
          ],
        });
      }
      continue;
    }
    if (now >= was) {
      faults.push({
        file,
        reasons: [
          `${now} frozen line(s), baseline ${was} — you touched this file, so leave it strictly shorter`,
        ],
      });
    }
  }
  return faults;
}

/** The files this branch changed since its merge-base, or `{skip}` naming why there is no delta. */
export function branchDelta(root) {
  const git = (args) => gitOut(args, root)?.trim() ?? null;
  const head = git(['rev-parse', 'HEAD']);
  if (!head) return { skip: 'no git HEAD' };
  const target = baseRef(root);
  if (target.refusal) return { skip: target.summary };
  const base = git(['merge-base', target.ref, 'HEAD']);
  if (!base) return { skip: `no merge-base with ${target.ref} (shallow or detached checkout)` };
  if (base === head) return { skip: `merge-base is HEAD (${base.slice(0, 8)}) — no branch delta` };

  const names = git(['diff', '--name-only', base]);
  const renames = git(['diff', '--diff-filter=R', '-M', '--name-status', base]);
  if (names === null || renames === null) return { error: `git diff against ${base} failed` };

  const changed = new Set(names.split('\n').filter(Boolean));
  const renamed = new Map();
  for (const line of renames.split('\n').filter(Boolean)) {
    const [, from, to] = line.split('\t');
    if (from && to) renamed.set(to, from);
  }
  return { base, changed, renamed };
}
