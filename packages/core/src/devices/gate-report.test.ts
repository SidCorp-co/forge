import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  readDeviceGate,
  readHeartbeatGate,
  storedGateReport,
  WIRE_REASONS,
  WIRE_UNITS,
} from './gate-report.js';

/**
 * The bytes the box actually puts on the heartbeat, asserted on the producing
 * side by `transport/heartbeat.rs`. Two hand-written literals agree until
 * somebody edits one; this is the same file read from both languages.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./gate-report.fixture.json', import.meta.url), 'utf8'),
) as { wire: { maxReasons: number; units: number }; degraded: unknown };

/** The gate body itself, as the heartbeat carries it. */
const onTheWire: unknown = { degraded: fixture.degraded };

const NOW = new Date('2026-09-24T12:00:00Z');

const condition = (over: Record<string, unknown> = {}) => ({
  verdict: 'failing_open',
  count: 279,
  trimmed: true,
  firstAt: 1_789_906_979_000,
  lastAt: 1_790_233_649_000,
  windowMs: 326_670_000,
  perDay: 73.8,
  sinceLastMs: 240_000,
  last: { detail: 'this pane carries no control capability', source: 'hook' },
  byReason: [{ reason: 'this pane carries no control capability', count: 279 }],
  ...over,
});

describe('readHeartbeatGate', () => {
  it('reads a condition the box sent', () => {
    const read = readHeartbeatGate({ degraded: condition() });
    expect(read.refused).toBeUndefined();
    expect(read.report?.degraded.count).toBe(279);
  });

  it('answers nothing at all for a heartbeat that carried no gate', () => {
    expect(readHeartbeatGate(undefined)).toEqual({});
  });

  // The refusal IS the deliverable: a box that reports into nothing and is not
  // told is the silence this whole record exists to end.
  it('names the field and the reason for a condition it cannot read', () => {
    const read = readHeartbeatGate({ degraded: condition({ verdict: 'catastrophe' }) });
    expect(read.report).toBeUndefined();
    expect(read.refused).toContain('degraded.verdict');
  });

  it('refuses a gate that is not an object at all rather than storing it', () => {
    expect(readHeartbeatGate('failing open').refused).toBeTruthy();
    expect(readHeartbeatGate(null).refused).toBeTruthy();
  });

  it('refuses a key it does not know, so a newer box is told rather than half-read', () => {
    const read = readHeartbeatGate({ degraded: condition(), undeclared: condition() });
    expect(read.refused).toBeTruthy();
  });
});

describe('readDeviceGate', () => {
  it('carries the condition and when core heard it', () => {
    const stored = storedGateReport({ degraded: condition() } as never, NOW);
    const read = readDeviceGate(stored);
    expect(read?.verdict).toBe('failing_open');
    expect(read?.count).toBe(279);
    expect(read?.byReason[0]?.count).toBe(279);
    expect(read?.receivedAt).toBe(NOW.toISOString());
  });

  it('answers null for a box that has never reported one', () => {
    expect(readDeviceGate(null)).toBeNull();
    expect(readDeviceGate(undefined)).toBeNull();
  });

  it('answers null rather than half a condition for a stored blob it cannot read', () => {
    expect(readDeviceGate({ degraded: { count: 3 } })).toBeNull();
  });
});

// Criterion 12. One planted tally — 24 marks over four hours, all one reason —
// read here exactly as the box derived it.
describe('the gate body the box sends', () => {
  it('is accepted, and its verdict, rate and window survive the crossing', () => {
    const read = readHeartbeatGate(onTheWire);
    expect(read.refused).toBeUndefined();
    expect(read.report?.degraded).toMatchObject({
      verdict: 'failing_open',
      count: 24,
      perDay: 144,
      windowMs: 14_400_000,
    });
  });

  it('reaches a surface with the same numbers it left the box with', () => {
    const read = readHeartbeatGate(onTheWire).report;
    if (!read) throw new Error('the fixture must parse, and the test above says why');
    const stored = storedGateReport(read, NOW);
    expect(readDeviceGate(stored)).toMatchObject({
      verdict: 'failing_open',
      count: 24,
      perDay: 144,
      windowMs: 14_400_000,
      byReason: [{ reason: "the daemon's control socket is not there", count: 24 }],
    });
  });

  it('carries what the newest mark admitted, so a run is identifiable after the fact', () => {
    const last = readHeartbeatGate(onTheWire).report?.degraded.last;
    expect(last).toMatchObject({ source: 'hook', role: 'forge:runner' });
    expect(last?.runUnknown).toContain('no registry of declared runs');
  });
});

describe('the wire bounds', () => {
  /**
   * Consult F1. These ceilings are the producer's, and a ceiling narrower than
   * what `daemon/degraded.rs` can emit refuses the whole report — so the box
   * failing in the most ways is the one core stops hearing from. The fixture
   * carries the numbers; `transport/heartbeat.rs` asserts the same two against
   * `MAX_REASONS` and `WIRE_UNITS_CEILING`.
   */
  it('are the ones the box says it emits', () => {
    expect(WIRE_REASONS).toBe(fixture.wire.maxReasons);
    expect(WIRE_UNITS).toBe(fixture.wire.units);
  });

  it("accept a breakdown at the producer's widest, and refuse one past it", () => {
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ reason: `reason ${i}`, count: 1 }));
    const at = readHeartbeatGate({ degraded: condition({ byReason: entries(WIRE_REASONS) }) });
    expect(at.report).toBeDefined();
    const past = readHeartbeatGate({
      degraded: condition({ byReason: entries(WIRE_REASONS + 1) }),
    });
    expect(past.report).toBeUndefined();
    expect(past.refused).toContain('byReason');
  });

  it("accept a string clipped to the producer's ceiling", () => {
    const detail = 'x'.repeat(WIRE_UNITS);
    const read = readHeartbeatGate({
      degraded: condition({ last: { detail, source: 'hook' } }),
    });
    expect(read.report?.degraded.last?.detail).toBe(detail);
  });

  /**
   * The unit is the whole finding. `z.string().max()` counts UTF-16 units, so a
   * producer clipping at 420 Unicode scalars sends 840 units of astral text and
   * the report is refused — a box gone quiet, which is this issue's own defect
   * arriving from inside its fix. `daemon/degraded.rs` clips in units; this is
   * the far end of that agreement.
   */
  it('measure a supplementary-plane string in the unit the producer clips it in', () => {
    const astral = '\u{1D518}'.repeat(WIRE_UNITS / 2);
    expect(astral.length).toBe(WIRE_UNITS);
    const at = readHeartbeatGate({
      degraded: condition({ last: { detail: astral, source: 'hook' } }),
    });
    expect(at.report?.degraded.last?.detail).toBe(astral);

    const over = readHeartbeatGate({
      degraded: condition({ last: { detail: `${astral}x`, source: 'hook' } }),
    });
    expect(over.report).toBeUndefined();
    expect(over.refused).toContain('detail');
  });
});
