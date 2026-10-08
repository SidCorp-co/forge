/**
 * The numbers a read holds and the test of a stated figure against them, shared by the rule that
 * holds a figure to a read (`figures-rule.ts`) and the rule that asks it to name that read
 * (`figure-sources.ts`).
 */

import type { ReportFrame } from '@forge/contracts/report-queries';
import { figuresIn, type StatedFigure } from './figure-exemptions.js';

/** The decimals a stated figure is matched to a read's value at: 41.67 is stated as 42 or 41.7. */
const DECIMALS = [0, 1, 2, 3] as const;

const UNIT_MS = [1000, 60_000, 3_600_000, 86_400_000, 604_800_000] as const;

const round = (n: number, d: number): number => Math.round(Math.abs(n) * 10 ** d) / 10 ** d;

/** The values, rounded: index `d` holds them at `d` decimals. */
export const atDecimals = (values: readonly number[]): ReadonlySet<number>[] =>
  DECIMALS.map((d) => new Set(values.map((v) => round(v, d))));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every value a result states: its JSON numbers, the figures its strings state and how many items
 * each of its lists holds (code counted them: "REQ-6 has 3 criteria" from a read of its three), or
 * its text read whole.
 */
export function valuesOfResult(text: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return figuresIn(text).flatMap((f) => f.readings.map((r) => r.value));
  }
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'string') {
      for (const f of figuresIn(v)) for (const r of f.readings) out.push(r.value);
    } else if (Array.isArray(v)) {
      out.push(v.length);
      v.forEach(walk);
    } else if (isRecord(v)) Object.values(v).forEach(walk);
  };
  walk(parsed);
  return out;
}

/** Every number the frames hold: a duration in each unit too, a frame's row count, a string cell's figures. */
export function frameValues(frames: readonly ReportFrame[]): number[] {
  const values: number[] = [];
  for (const frame of frames) {
    values.push(frame.rows.length);
    const durations = new Set(frame.fields.filter((f) => f.type === 'duration').map((f) => f.name));
    for (const row of frame.rows) {
      for (const [name, cell] of Object.entries(row)) {
        if (typeof cell === 'number') {
          values.push(cell);
          if (durations.has(name)) for (const unit of UNIT_MS) values.push(cell / unit);
        } else if (typeof cell === 'string') {
          for (const f of figuresIn(cell)) for (const r of f.readings) values.push(r.value);
        }
      }
    }
  }
  return values;
}

/** Whether a reading of the figure is one of `sets`' values, at the decimals it is stated to. */
export function holds(figure: StatedFigure, sets: readonly ReadonlySet<number>[]): boolean {
  return figure.readings.some((r) => {
    const d = Math.min(r.decimals, DECIMALS.length - 1);
    return sets[d]?.has(round(r.value, d)) ?? false;
  });
}
