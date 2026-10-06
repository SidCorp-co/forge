import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { GATE_ALERT_ENTITY_LIMIT, GATE_REPORT_FRESH_MS, gateAlert } = await import(
  './gate-alert.js'
);

const NOW = new Date('2026-10-07T00:00:00Z');

const condition = (over: Record<string, unknown> = {}) => ({
  verdict: 'failing_open',
  count: 409,
  trimmed: true,
  firstAt: Date.parse('2026-09-20T12:22:59Z'),
  lastAt: Date.parse('2026-09-29T15:49:46Z'),
  windowMs: 790_000_000,
  perDay: 45,
  sinceLastMs: 240_000,
  last: { detail: 'the process this hook ran in carries no control capability', source: 'hook' },
  byReason: [{ reason: 'this pane carries no control capability', count: 281 }],
  ...over,
});

const box = (
  name: string,
  over: { degraded?: unknown; receivedAt?: string; disabledAt?: string | null } = {},
) => ({
  id: `00000000-0000-4000-8000-${name.padStart(12, '0').slice(-12)}`,
  name,
  disabledAt: over.disabledAt ?? null,
  gateReport: {
    degraded: over.degraded ?? condition(),
    receivedAt: over.receivedAt ?? new Date(NOW.getTime() - 30_000).toISOString(),
  },
});

describe('A6, a box whose gate is failing open (ISS-1324)', () => {
  it('warns naming the box, its count as a floor, and its rate, when a fresh report fails open', () => {
    const a = gateAlert([box('sid-xeon-1')], NOW);
    expect(a.id).toBe('A6');
    expect(a.key).toBe('gate_failing_open');
    expect(a.status).toBe('warn');
    expect(a.count).toBe(1);
    expect(a.detail).toBe(
      'sid-xeon-1: at least 409 dispatch(es) admitted without the gate deciding, 45/day over 9d',
    );
    expect(a.since).toBe('2026-09-20T12:22:59.000Z');
    expect(a.entities).toEqual([
      {
        ref: box('sid-xeon-1').id,
        kind: 'device',
        label: 'sid-xeon-1 · at least 409 undecided, 45/day over 9d',
      },
    ]);
  });

  it('states an untrimmed count whole', () => {
    const a = gateAlert([box('b', { degraded: condition({ trimmed: false, count: 40 }) })], NOW);
    expect(a.detail).toContain('b: 40 dispatch(es)');
    expect(a.detail).not.toContain('at least');
  });

  it('counts every box failing open and names each, the largest first', () => {
    const a = gateAlert(
      [
        box('small', { degraded: condition({ count: 20, trimmed: false }) }),
        box('large', { degraded: condition({ count: 300 }) }),
        box('clear', { degraded: condition({ verdict: 'clear', count: 0 }) }),
      ],
      NOW,
    );
    expect(a.status).toBe('warn');
    expect(a.count).toBe(2);
    expect(a.detail).toBe('2 boxes admitting dispatches their gate could not decide');
    expect(a.entities.map((e) => e.label.split(' · ')[0])).toEqual(['large', 'small']);
  });

  it('counts every box failing open but names only as many as every Tier 1 alert carries', () => {
    const rows = Array.from({ length: GATE_ALERT_ENTITY_LIMIT + 1 }, (_, i) =>
      box(`box-${String(i).padStart(2, '0')}`),
    );
    const a = gateAlert(rows, NOW);
    expect(a.count).toBe(GATE_ALERT_ENTITY_LIMIT + 1);
    expect(a.entities).toHaveLength(GATE_ALERT_ENTITY_LIMIT);
    expect(a.detail).toBe(
      `${GATE_ALERT_ENTITY_LIMIT + 1} boxes admitting dispatches their gate could not decide`,
    );
  });

  it('reads ok when no box reports anything', () => {
    const a = gateAlert([], NOW);
    expect(a.status).toBe('ok');
    expect(a.count).toBe(0);
    expect(a.since).toBeNull();
    expect(a.entities).toEqual([]);
  });

  it.each([
    ['marked', box('m', { degraded: condition({ verdict: 'marked' }) })],
    ['clear', box('c', { degraded: condition({ verdict: 'clear', count: 0 }) })],
    [
      'heard one millisecond past the freshness bound',
      box('s', {
        receivedAt: new Date(NOW.getTime() - GATE_REPORT_FRESH_MS - 1).toISOString(),
      }),
    ],
    ['heard at no time core can read', box('t', { receivedAt: 'yesterday' })],
    ['unreadable', box('u', { degraded: { verdict: 'failing_open' } })],
    ['disabled', box('d', { disabledAt: '2026-10-01T00:00:00Z' })],
    ['absent', { id: 'x', name: 'x', disabledAt: null, gateReport: null }],
  ])('reads ok for a box whose report is %s', (_, row) => {
    const a = gateAlert([row], NOW);
    expect(a.status).toBe('ok');
    expect(a.count).toBe(0);
  });

  it('still counts a report heard exactly at the freshness bound', () => {
    const a = gateAlert(
      [box('edge', { receivedAt: new Date(NOW.getTime() - GATE_REPORT_FRESH_MS).toISOString() })],
      NOW,
    );
    expect(a.status).toBe('warn');
  });

  it('states no rate where the box sent none', () => {
    const a = gateAlert([box('r', { degraded: condition({ perDay: null }) })], NOW);
    expect(a.detail).toContain('admitted without the gate deciding, over 9d');
    expect(a.detail).not.toContain('/day');
  });
});
