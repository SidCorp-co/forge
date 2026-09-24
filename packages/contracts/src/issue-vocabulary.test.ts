import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_LABELS,
  LABEL_TO_KERNEL,
  statusesForLabels,
  toAutonomousLabel,
  type WritableLabel,
} from './issue-vocabulary.js';
import { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

/** The statuses that read `running` on a held row — derived, so the tests track the map. */
const IN_FLIGHT = REGISTRY_ISSUE_STATUSES.filter((s) => toAutonomousLabel(s, true) === 'running');

describe('toAutonomousLabel', () => {
  it('has a label for every kernel status, held or not, including ones the driver never writes', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      expect(AUTONOMOUS_LABELS).toContain(toAutonomousLabel(status, true));
      expect(AUTONOMOUS_LABELS).toContain(toAutonomousLabel(status, false));
    }
  });

  it('reads the staged middle as running while something holds the row', () => {
    for (const status of ['confirmed', 'approved', 'developed', 'testing'] as const) {
      expect(toAutonomousLabel(status, true)).toBe('running');
    }
  });

  // ISS-1213: eleven rows stood at `testing` for 5–12h with nothing on ten of them, all reading
  // `running`. The same row with nothing on it reads `stalled`.
  it('reads a row nothing holds as stalled, never as running', () => {
    expect(toAutonomousLabel('testing', false)).toBe('stalled');
    for (const status of IN_FLIGHT) {
      expect([status, toAutonomousLabel(status, false)]).toEqual([status, 'stalled']);
    }
  });

  it('counts the seven statuses whose word needs a holder, and no others', () => {
    expect([...IN_FLIGHT].sort()).toEqual(
      [
        'approved',
        'clarified',
        'confirmed',
        'developed',
        'in_progress',
        'releasing',
        'testing',
      ].sort(),
    );
  });

  it('reads every status outside that set the same word whether or not the row is held', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      if (IN_FLIGHT.includes(status)) continue;
      expect([status, toAutonomousLabel(status, false)]).toEqual([
        status,
        toAutonomousLabel(status, true),
      ]);
    }
  });

  it('collapses the two statuses that ask a human into needs_human', () => {
    for (const status of ['waiting', 'needs_info'] as const) {
      expect(toAutonomousLabel(status, false)).toBe('needs_human');
    }
  });

  it('reads a deliberate pause as paused, never as a question for a human', () => {
    expect(toAutonomousLabel('on_hold', false)).toBe('paused');
    expect(toAutonomousLabel('on_hold', false)).not.toBe('needs_human');
  });

  it('keeps done and dropped apart', () => {
    expect(toAutonomousLabel('closed', false)).toBe('done');
    expect(toAutonomousLabel('dropped', false)).toBe('dropped');
  });

  it('reads either release park as its own label, not as running or stalled', () => {
    expect(toAutonomousLabel('awaiting_release', false)).toBe('awaiting_release');
    expect(toAutonomousLabel('tested', false)).toBe('awaiting_release');
  });

  it('reads reopen as a close somebody disputed, not as a session or a queue', () => {
    expect(toAutonomousLabel('reopen', false)).toBe('reopened');
    expect(toAutonomousLabel('reopen', false)).not.toBe('open');
    expect(statusesForLabels('needs_human')).not.toContain('reopen');
  });
});

describe('LABEL_TO_KERNEL', () => {
  const writable = AUTONOMOUS_LABELS.filter((l): l is WritableLabel => l !== 'stalled');

  it('writes every label but stalled to a status the kernel enum defines', () => {
    expect(Object.keys(LABEL_TO_KERNEL).sort()).toEqual([...writable].sort());
    for (const label of writable) {
      expect(REGISTRY_ISSUE_STATUSES).toContain(LABEL_TO_KERNEL[label]);
    }
  });

  it('round-trips every writable label through the kernel and back, on a held row', () => {
    for (const label of writable) {
      expect(toAutonomousLabel(LABEL_TO_KERNEL[label], true)).toBe(label);
    }
  });
});

describe('statusesForLabels', () => {
  it('answers with exactly the statuses carrying the labels asked for', () => {
    expect(statusesForLabels('needs_human')).toEqual(['waiting', 'needs_info']);
    expect(statusesForLabels('paused')).toEqual(['on_hold']);
    expect(statusesForLabels('needs_human', 'paused')).toEqual([
      'waiting',
      'on_hold',
      'needs_info',
    ]);
  });

  it('names the same statuses for running and for stalled, because a filter cannot see the holder', () => {
    expect(statusesForLabels('stalled')).toEqual(statusesForLabels('running'));
    expect([...statusesForLabels('running')].sort()).toEqual([...IN_FLIGHT].sort());
  });

  it('answers with nothing when no status carries the label', () => {
    expect(statusesForLabels()).toEqual([]);
  });

  it("returns statuses in the map's own order, not the caller's", () => {
    expect(statusesForLabels('paused', 'needs_human')).toEqual(
      statusesForLabels('needs_human', 'paused'),
    );
  });
});
