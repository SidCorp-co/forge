import { describe, expect, it } from 'vitest';
import { markFor, tally, tallyLine } from './verify-report.mjs';

const ran = (code) => ({ code, condition: undefined });
const skipped = { code: 0, condition: 'skipped' };
const blocked = { code: 2, condition: 'blocked' };

describe('markFor', () => {
  it('never prints ok for a check whose prerequisite was absent', () => {
    expect(markFor(skipped)).not.toBe('ok  ');
    expect(markFor(skipped).trim()).toBe('skip');
  });

  it('separates a skip from a checker that could not run', () => {
    expect(markFor(blocked).trim()).toBe('n/a');
    expect(markFor(blocked)).not.toBe(markFor(skipped));
  });

  it('keeps ok for a check that ran and passed', () => {
    expect(markFor(ran(0)).trim()).toBe('ok');
  });

  it('marks a violation red and an unauditable checker FAIL', () => {
    expect(markFor(ran(1)).trim()).toBe('red');
    expect(markFor(ran(2)).trim()).toBe('FAIL');
  });
});

describe('tally', () => {
  it('counts a skip as did-not-run, never as passed', () => {
    const t = tally([ran(0), skipped]);
    expect(t).toEqual({ passed: 1, notRun: 1, red: 0 });
  });

  it('counts a blocked check as did-not-run too', () => {
    expect(tally([blocked])).toEqual({ passed: 0, notRun: 1, red: 0 });
  });

  it('counts a violation as red', () => {
    expect(tally([ran(1)])).toEqual({ passed: 0, notRun: 0, red: 1 });
  });

  it('names both halves in the line, even when nothing was skipped', () => {
    expect(tallyLine(tally([ran(0), ran(0)]))).toBe('2 passed · 0 did not run');
  });

  it('names how many did not run', () => {
    expect(tallyLine(tally([ran(0), skipped, blocked]))).toBe('1 passed · 2 did not run');
  });
});
