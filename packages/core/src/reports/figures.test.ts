import type { ReportFrame } from '@forge/contracts/report-queries';
import { describe, expect, it } from 'vitest';
import { figuresNotInRun } from './figures.js';

// A block's figures are its run's alone: a frame the block brings is compared with the stored one,
// and every figure the run never read is named with where it sits and what the run read instead.

const run: ReportFrame = {
  fields: [
    { name: 'key', type: 'ref', label: 'Requirement' },
    { name: 'proven', type: 'number', label: 'Proven' },
  ],
  rows: [
    { key: 'REQ-1', proven: 3 },
    { key: 'REQ-2', proven: 5 },
  ],
};

describe('figuresNotInRun', () => {
  it("finds nothing in a frame that is the run's", () => {
    expect(figuresNotInRun(structuredClone(run), run, 'r1')).toEqual([]);
  });

  it('names a figure the run never read, with the cell and what the run read there', () => {
    const typed = structuredClone(run);
    (typed.rows[1] as Record<string, unknown>).proven = 9;
    expect(figuresNotInRun(typed, run, 'r1')).toEqual([
      'frame.rows.1.proven: the block holds 9, run r1 read 5',
    ]);
  });

  it('names a field the run did not answer and a cell no field of the run holds', () => {
    const typed = {
      fields: [...run.fields, { name: 'velocity', type: 'number', label: 'Velocity' }],
      rows: run.rows.map((r) => ({ ...r, velocity: 12 })),
    };
    const out = figuresNotInRun(typed, run, 'r1');
    expect(out[0]).toBe(
      'frame.fields.2: field "velocity" is not one run r1 answered; it answered key, proven',
    );
    expect(out).toContain('frame.rows.0.velocity: 12 is a figure no field of run r1 holds');
  });

  it('names a row the run never read, and a field declared otherwise', () => {
    const typed = {
      fields: [run.fields[0], { name: 'proven', type: 'number', label: 'Proven', unit: '%' }],
      rows: [...run.rows, { key: 'REQ-3', proven: 1 }],
    };
    const out = figuresNotInRun(typed, run, 'r1');
    expect(out[0]).toContain('frame.fields.1: field "proven" is declared');
    expect(out).toContain('frame.rows: the block holds 3 row(s), run r1 read 2');
  });

  it('names a status field read through another vocabulary than the run declared', () => {
    const held: ReportFrame = {
      fields: [{ name: 'state', type: 'status', label: 'State', vocabulary: 'requirement' }],
      rows: [{ state: 'agreed' }],
    };
    const typed = { ...held, fields: [{ ...held.fields[0], vocabulary: 'releaseState' }] };
    expect(figuresNotInRun(typed, held, 'r1')).toEqual([
      'frame.fields.0: field "state" is declared {"name":"state","type":"status","label":"State","vocabulary":"releaseState"}, but run r1 declared it {"name":"state","type":"status","label":"State","vocabulary":"requirement"}',
    ]);
  });

  it('names a frame that is no frame at all', () => {
    expect(figuresNotInRun(7, run, 'r1')[0]).toContain('not a frame');
  });

  it('lists at most eight differences and counts the rest', () => {
    const big: ReportFrame = {
      fields: run.fields,
      rows: Array.from({ length: 20 }, (_, i) => ({ key: `REQ-${i}`, proven: i })),
    };
    const typed = { fields: run.fields, rows: big.rows.map((r) => ({ ...r, proven: -1 })) };
    const out = figuresNotInRun(typed, big, 'r1');
    expect(out).toHaveLength(9);
    expect(out.at(-1)).toBe('and 12 more difference(s)');
  });
});
