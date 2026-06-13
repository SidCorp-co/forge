/**
 * ISS-447 (ISS-442 C1, I2) — the single-writer GUARD.
 *
 * Fails the build if any file under `packages/core/src` (other than the
 * chokepoint `lifecycle/transition.ts` itself) writes a TERMINAL status to one
 * of the three kernel tables via a Drizzle `.update(<table>).set({ status:
 * <terminal> })`, or via a raw-SQL `UPDATE <table> SET ... status = '<terminal>'`.
 *
 * This is what makes invariant I2 real: a new code path that flips a job /
 * session / run terminal WITHOUT routing through `applyKernelTransition` (and
 * therefore without writing the `kernel_transitions` audit row) cannot land —
 * CI rejects it here. Non-terminal writes (queued/running/dispatched/idle/
 * paused resets) are deliberately allowed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url)); // packages/core/src

// Drizzle model var name → its TERMINAL status literals. Non-terminal statuses
// are intentionally omitted (they are legal writes outside the chokepoint).
const KERNEL_TABLES: Record<string, string[]> = {
  jobs: ['done', 'failed', 'cancelled'],
  agentSessions: ['completed', 'failed', 'completed_via_recovery', 'cancelled_stale'],
  pipelineRuns: ['completed', 'failed', 'cancelled'],
};

// Raw-SQL table name (snake_case) → terminal literals, for the `UPDATE <table>
// SET ... status = '<terminal>'` escape hatch (e.g. sql.raw stale sweepers).
const RAW_TABLES: Record<string, string[]> = {
  jobs: ['done', 'failed', 'cancelled'],
  agent_sessions: ['completed', 'failed', 'completed_via_recovery', 'cancelled_stale'],
  pipeline_runs: ['completed', 'failed', 'cancelled'],
};

const CHOKEPOINT = 'lifecycle/transition.ts';

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so prose like "caller owns the `UPDATE jobs SET
 *  status='failed'`" in a JSDoc header can't trip the scanners. Heuristic, not a
 *  full lexer: good enough for guard-rail purposes. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (skip scheme:// in URLs)
}

/** Scan one file for bypassing terminal writes; returns human-readable hits. */
function findViolations(path: string, rawBody: string): string[] {
  const body = stripComments(rawBody);
  const hits: string[] = [];

  for (const [table, terminals] of Object.entries(KERNEL_TABLES)) {
    // Each `.update(<table>)` call; capture the segment up to the next `.where(`
    // (or `.returning(` / end-of-statement) which spans the `.set({...})`.
    const re = new RegExp(`\\.update\\(\\s*${table}\\s*\\)`, 'g');
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      const start = m.index;
      const rest = body.slice(start, start + 600);
      const segEnd = rest.search(/\.where\(|\.returning\(|;\n/);
      const seg = segEnd === -1 ? rest : rest.slice(0, segEnd);
      if (/status\s*:/.test(seg)) {
        for (const term of terminals) {
          if (seg.includes(`'${term}'`) || seg.includes(`"${term}"`)) {
            hits.push(`${path}: .update(${table}).set({ status: '${term}' })`);
            break;
          }
        }
      }
      m = re.exec(body);
    }
  }

  for (const [table, terminals] of Object.entries(RAW_TABLES)) {
    const re = new RegExp(`UPDATE\\s+"?${table}"?\\b[\\s\\S]{0,400}?status\\s*=\\s*'([a-z_]+)'`, 'gi');
    let m: RegExpExecArray | null = re.exec(body);
    while (m !== null) {
      const term = m[1];
      if (term && terminals.includes(term)) {
        hits.push(`${path}: raw UPDATE ${table} SET status = '${term}'`);
      }
      m = re.exec(body);
    }
  }

  return hits;
}

describe('kernel transition single-writer guard (I2)', () => {
  it('no file outside lifecycle/transition.ts writes a terminal kernel status directly', () => {
    const files = listSourceFiles(SRC_ROOT).filter((f) => !f.endsWith(CHOKEPOINT));
    const violations: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, 'utf8');
      violations.push(...findViolations(file, body));
    }
    expect(
      violations,
      `Terminal status on jobs/agent_sessions/pipeline_runs must go through ` +
        `applyKernelTransition (lifecycle/transition.ts). Offending sites:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the guard actually detects a planted bypass (meta-test)', () => {
    const planted = `await db.update(jobs).set({ status: 'done', exitCode: 0 }).where(eq(jobs.id, x));`;
    expect(findViolations('synthetic.ts', planted).length).toBeGreaterThan(0);
    const rawPlanted = `sql.raw("UPDATE jobs SET status = 'failed' WHERE id = '1'")`;
    expect(findViolations('synthetic.ts', rawPlanted).length).toBeGreaterThan(0);
    // Non-terminal writes are allowed.
    const ok = `await db.update(agentSessions).set({ status: 'queued' }).where(eq(agentSessions.id, x));`;
    expect(findViolations('synthetic.ts', ok)).toEqual([]);
  });
});
