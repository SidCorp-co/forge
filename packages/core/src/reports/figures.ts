// A block's figures must be its run's: a block that brings a frame of its own is compared with the
// frame its run stored, and every field, row or cell that differs is named. Pure, so both doors and
// a test judge it alike.

import type { ReportFrame } from '@forge/contracts/report-queries';

/** The most differences one refusal lists; the count of the rest is said. */
const LISTED = 8;

const said = (v: unknown): string => (v === undefined ? 'nothing' : JSON.stringify(v));

/**
 * Every place `given` departs from the run's frame: a field the run did not answer or answered
 * otherwise, a row count that differs, a cell that holds another value. Empty when the block's frame
 * is the run's.
 */
export function figuresNotInRun(given: unknown, run: ReportFrame, runId: string): string[] {
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    return [
      `frame: the block's frame is ${said(given)}, not a frame; omit it and the frame of run ${runId} is copied in`,
    ];
  }
  const out: string[] = [];
  const g = given as { fields?: unknown; rows?: unknown };
  const fields = Array.isArray(g.fields) ? (g.fields as Record<string, unknown>[]) : [];
  const rows = Array.isArray(g.rows) ? (g.rows as Record<string, unknown>[]) : [];
  const runFields = new Map(run.fields.map((f) => [f.name, f]));
  for (const [i, f] of fields.entries()) {
    const name = typeof f?.name === 'string' ? f.name : said(f?.name);
    const held = runFields.get(name);
    if (!held) {
      out.push(
        `frame.fields.${i}: field "${name}" is not one run ${runId} answered; it answered ${run.fields.map((x) => x.name).join(', ')}`,
      );
    } else if (f.type !== held.type || f.unit !== held.unit || f.label !== held.label) {
      out.push(
        `frame.fields.${i}: field "${name}" is declared ${said(f)}, but run ${runId} declared it ${said(held)}`,
      );
    }
  }
  for (const f of run.fields) {
    if (!fields.some((x) => x?.name === f.name))
      out.push(
        `frame.fields: run ${runId} answered field "${f.name}" and the block's frame leaves it out`,
      );
  }
  if (rows.length !== run.rows.length) {
    out.push(
      `frame.rows: the block holds ${rows.length} row(s), run ${runId} read ${run.rows.length}`,
    );
  }
  for (const [r, row] of rows.entries()) {
    const ran = run.rows[r];
    if (!ran || row === null || typeof row !== 'object') continue;
    for (const [name, cell] of Object.entries(row)) {
      if (!runFields.has(name)) {
        out.push(
          `frame.rows.${r}.${name}: ${said(cell)} is a figure no field of run ${runId} holds`,
        );
      } else if (ran[name] !== cell) {
        out.push(
          `frame.rows.${r}.${name}: the block holds ${said(cell)}, run ${runId} read ${said(ran[name])}`,
        );
      }
    }
  }
  if (out.length <= LISTED) return out;
  return [...out.slice(0, LISTED), `and ${out.length - LISTED} more difference(s)`];
}
