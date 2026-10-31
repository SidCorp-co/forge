/**
 * ISS-809 — what the declared gate check reads at a commit, from the host's own list of checks: the
 * pure half of `declared-gate.ts`, with no host and no database. Each case plants the list the host
 * would answer and asserts the one state it must read as.
 *
 * @direct-test-of packages/core/src/integrations/source-host/projection-shape.ts
 */

import { describe, expect, it } from 'vitest';
import {
  declaredGateBlocker,
  declaredGateReading,
  GATE_REPORT_WINDOW_MINUTES,
} from './declared-gate.js';

const COMMIT = 'f1bb20e6d3a94c0e8b71a2c5d4e9f0a1b2c3d4e5';
const NOW = new Date('2026-10-30T11:00:00Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const run = (over: Partial<Record<string, string | null>> = {}) => ({
  id: '1',
  name: 'gate',
  app: 'github-actions',
  headSha: COMMIT,
  status: 'completed',
  conclusion: 'success',
  detailsUrl: null,
  startedAt: '2026-10-30T10:00:00Z',
  completedAt: '2026-10-30T10:05:00Z',
  ...over,
});

const read = (checks: ReturnType<typeof run>[], committedAt: string | null = minutesBefore(5)) =>
  declaredGateReading({ check: 'gate', commit: COMMIT, checks, committedAt, now: NOW });

describe('what the declared gate check reads at a commit', () => {
  it('reads a finished green run as a pass', () => {
    expect(read([run()]).state).toBe('pass');
    expect(read([run({ conclusion: 'neutral' })]).state).toBe('pass');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'failed', 'error'])(
    'reads a run that concluded %s as red, naming the conclusion',
    (conclusion) => {
      expect(read([run({ conclusion })])).toMatchObject({ state: 'red', conclusion });
    },
  );

  it('reads a run with no conclusion yet as pending, queued or running', () => {
    expect(read([run({ status: 'queued', conclusion: null })])).toMatchObject({
      state: 'pending',
      status: 'queued',
    });
    expect(read([run({ status: 'in_progress', conclusion: null })])).toMatchObject({
      state: 'pending',
      status: 'running',
    });
  });

  it('lets a re-run replace the run it re-ran, either way round', () => {
    const failed = run({ id: '1', conclusion: 'failure', startedAt: '2026-10-30T10:00:00Z' });
    const green = run({ id: '2', conclusion: 'success', startedAt: '2026-10-30T10:30:00Z' });
    expect(read([failed, green]).state).toBe('pass');
    expect(read([run({ ...green, startedAt: '2026-10-30T09:00:00Z' }), failed]).state).toBe('red');
    const rerunning = run({
      id: '3',
      status: 'in_progress',
      conclusion: null,
      startedAt: '2026-10-30T10:40:00Z',
    });
    expect(read([failed, green, rerunning]).state).toBe('pending');
  });

  it('reads red before pending: a commit with one red run is refused whatever else is running', () => {
    const other = run({ id: '2', app: 'other-ci', status: 'in_progress', conclusion: null });
    expect(read([run({ conclusion: 'failure' }), other]).state).toBe('red');
  });

  it('counts only the named check, only at this commit, and exactly by name', () => {
    expect(read([run({ name: 'Gate' })]).state).toBe('pending');
    expect(read([run({ name: 'gate-extra' })]).state).toBe('pending');
    expect(read([run({ headSha: 'a'.repeat(40) })]).state).toBe('pending');
    expect(read([run({ conclusion: 'failure', headSha: COMMIT.toUpperCase() })]).state).toBe('red');
  });

  it('waits, saying since when, for a young commit nothing has reported on', () => {
    expect(read([], minutesBefore(GATE_REPORT_WINDOW_MINUTES - 1))).toMatchObject({
      state: 'pending',
      status: 'unreported',
      since: minutesBefore(GATE_REPORT_WINDOW_MINUTES - 1),
    });
  });

  it('turns silent at the window, and where the host gave no commit time or an unreadable one', () => {
    expect(read([], minutesBefore(GATE_REPORT_WINDOW_MINUTES)).state).toBe('silent');
    expect(read([], minutesBefore(600))).toMatchObject({
      state: 'silent',
      since: minutesBefore(600),
    });
    expect(read([], null)).toMatchObject({ state: 'silent', since: null });
    expect(read([], 'not a time')).toMatchObject({ state: 'silent', since: null });
  });
});

describe('the release blocker a reading stands as', () => {
  it('stands for nothing where nothing is declared or the check passed', () => {
    expect(declaredGateBlocker({ state: 'none' })).toBeNull();
    expect(declaredGateBlocker({ state: 'pass', check: 'gate', commit: COMMIT })).toBeNull();
  });

  it('names the check, the short commit and its state in each sentence', () => {
    const red = declaredGateBlocker(read([run({ conclusion: 'failure' })]));
    expect(red?.code).toBe('RELEASE_GATE_CHECK_RED');
    expect(red?.message).toContain('`gate`');
    expect(red?.message).toContain(COMMIT.slice(0, 12));
    expect(red?.message).toContain('(failure)');

    const silent = declaredGateBlocker(read([], minutesBefore(90)));
    expect(silent?.code).toBe('RELEASE_GATE_CHECK_SILENT');
    expect(silent?.message).toContain(`${GATE_REPORT_WINDOW_MINUTES} minutes allowed`);
    expect(silent?.message).toContain('`{ "type": "none" }`');

    const unread = declaredGateBlocker({
      state: 'unread',
      check: 'gate',
      where: 'the head of `main`',
      reason: 'GitHub answered 502',
    });
    expect(unread?.code).toBe('RELEASE_GATE_CHECK_UNREAD');
    expect(unread?.message).toContain('the head of `main`: GitHub answered 502');
  });

  it('words a pending hold without a running age, so the same wait is the same words each sweep', () => {
    const wait = declaredGateBlocker(read([run({ status: 'in_progress', conclusion: null })]));
    expect(wait?.code).toBe('RELEASE_GATE_CHECK_PENDING');
    expect(wait?.message).toContain('still running');
    expect(wait?.message).not.toMatch(/\d+s ago|\d+ minutes ago/);
  });
});
