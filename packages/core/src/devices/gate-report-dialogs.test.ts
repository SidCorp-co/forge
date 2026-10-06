import { describe, expect, it } from 'vitest';
import fixture from './gate-report.fixture.json' with { type: 'json' };
import { heartbeatGate, readDialogsAnswered, WIRE_DIALOG_PROJECTS } from './gate-report.js';
import { heartbeatPatch } from './heartbeat-patch.js';

const NOW = new Date('2026-10-07T18:00:00Z');
const answered = (projectId: string | null, count: number) => ({
  projectId,
  count,
  countIsFloor: false,
  firstAt: Date.parse('2026-10-07T17:42:00Z'),
  lastAt: Date.parse('2026-10-07T18:06:00Z'),
  last: "denied Bash: bash -c ' for n in 1 2; do rm -f $S/out-$n.json done'",
  lastAgent: 'a1b2c3',
});

describe('the dialogs a box answered ride on its gate report and reach masters/standing', () => {
  it('a gate carrying answered dialogs is stored, and standing reads its own project', () => {
    const gate = { degraded: fixture.degraded, dialogs: [answered('p1', 3), answered('p2', 1)] };
    const read = heartbeatGate(gate, 'd1');
    expect(read.ack).toEqual({ gate: { accepted: true } });
    const stored = heartbeatPatch({ gate: read.report }, NOW).gateReport;
    expect(readDialogsAnswered(stored, 'p1')).toEqual({
      count: 3,
      countIsFloor: false,
      firstAt: '2026-10-07T17:42:00.000Z',
      lastAt: '2026-10-07T18:06:00.000Z',
      last: "denied Bash: bash -c ' for n in 1 2; do rm -f $S/out-$n.json done'",
      lastAgent: 'a1b2c3',
    });
    expect(readDialogsAnswered(stored, 'p3')).toBeNull();
  });

  it('a gate with no dialogs key answers none, and keeps its degraded half', () => {
    const read = heartbeatGate({ degraded: fixture.degraded }, 'd1');
    expect(read.ack).toEqual({ gate: { accepted: true } });
    expect(
      readDialogsAnswered(heartbeatPatch({ gate: read.report }, NOW).gateReport, 'p1'),
    ).toBeNull();
    expect(readDialogsAnswered(null, 'p1')).toBeNull();
  });

  it('a malformed or oversized dialogs list refuses the gate by name, not the heartbeat', () => {
    const bad = heartbeatGate({ degraded: fixture.degraded, dialogs: [{ projectId: 'p1' }] }, 'd1');
    expect(bad.report).toBeUndefined();
    expect(bad.ack).toMatchObject({ gate: { accepted: false } });
    expect(JSON.stringify(bad.ack)).toContain('gate.dialogs.0');
    const many = Array.from({ length: WIRE_DIALOG_PROJECTS + 1 }, (_, i) => answered(`p${i}`, 1));
    const over = heartbeatGate({ degraded: fixture.degraded, dialogs: many }, 'd1');
    expect(over.ack).toMatchObject({ gate: { accepted: false } });
  });
});
