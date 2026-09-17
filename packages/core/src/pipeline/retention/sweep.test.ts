import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
const selectMock = vi.fn();
const warnMock = vi.fn();
const infoMock = vi.fn();
const deriveMock = vi.fn(async () => {});

vi.mock('../../db/client.js', () => ({
  db: {
    execute: executeMock,
    select: () => ({ from: () => ({ where: selectMock }) }),
  },
}));
vi.mock('../../logger.js', () => ({ logger: { warn: warnMock, info: infoMock, error: vi.fn() } }));
vi.mock('../../queue/boss.js', () => ({
  boss: { createQueue: vi.fn(async () => {}), schedule: vi.fn(async () => {}), work: vi.fn() },
}));
vi.mock('../../jobs/session-transcript.js', () => ({ deriveSessionFinal: deriveMock }));

const { runRetentionSweep } = await import('./sweep.js');
const { RETENTION_STATEMENTS } = await import('./statements.js');
const { RETENTION_RULES } = await import('./policy.js');

/** Rows for a delete batch (ids removed) or a count read, in call order. */
function answerWith(answers: unknown[]): void {
  let i = 0;
  executeMock.mockImplementation(async () => answers[i++] ?? []);
}

beforeEach(() => {
  executeMock.mockReset();
  selectMock.mockReset();
  warnMock.mockReset();
  infoMock.mockReset();
  deriveMock.mockClear();
  selectMock.mockResolvedValue([]);
  process.env.RETENTION_FINALIZE_REPAIR_MAX = '0';
});

describe('retention sweep: coverage of the stated rules', () => {
  // cm:guard a rule with a window and no statement sweeps NOTHING and reports `deleted: 0`, which is indistinguishable in a log from a table that was already clean. This is the only thing that catches a seventh table being stated and never wired.
  it('has a statement for every rule that states a window, and none for those that do not', () => {
    for (const rule of RETENTION_RULES) {
      const wired = Object.hasOwn(RETENTION_STATEMENTS, rule.table);
      expect({ table: rule.table, wired }).toEqual({
        table: rule.table,
        wired: rule.days !== null,
      });
    }
  });
});

describe('retention sweep: the batch loop', () => {
  it('reports every stated rule, deleting nothing when no table has an over-age row', async () => {
    answerWith([]);
    const result = await runRetentionSweep();

    expect(result.tables.map((t) => t.table)).toEqual(RETENTION_RULES.map((r) => r.table));
    expect(result.deleted).toBe(0);
  });

  it('keeps asking while a batch comes back full, and stops on a short one', async () => {
    const full = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i) }));
    // job_events is the first stated rule: two full batches, then three rows,
    // then its held-back count. Every later table answers empty.
    answerWith([full, full, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ n: 0 }]]);

    const result = await runRetentionSweep();
    const jobEvents = result.tables.find((t) => t.table === 'job_events');

    expect(jobEvents?.deleted).toBe(20_003);
    // Three batches for `job_events` rather than one, plus one statement per
    // remaining swept table, one more per table that reads a held-back count,
    // and the truncated-history report, which runs even with the repair bound at
    // zero because it reports rather than repairs.
    const swept = RETENTION_RULES.filter((r) => r.days !== null).length;
    const held = Object.values(RETENTION_STATEMENTS).filter((t) => t.heldBack !== null).length;
    expect(executeMock).toHaveBeenCalledTimes(3 + (swept - 1) + held + 1);
  });

  // cm:guard `heldBack` is a count of what is left past the window, so at the batch cap it counts an undrained backlog as well as what a rule keeps. Two different facts under one number is the shape this repo calls a silent substitution, so the cap is reported rather than folded away.
  it('says when the batch cap stopped it before the table ran out of rows', async () => {
    const full = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i) }));
    executeMock.mockResolvedValue(full);

    const result = await runRetentionSweep();
    const jobEvents = result.tables.find((t) => t.table === 'job_events');

    expect(jobEvents?.capped).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'job_events' }),
      expect.stringContaining('batch cap'),
    );
  });

  it('does not say it was capped when a short batch ended the loop', async () => {
    answerWith([[{ id: 'a' }]]);
    const result = await runRetentionSweep();

    expect(result.tables.every((t) => t.capped === false)).toBe(true);
  });

  it('reads the held-back count for a rule that has an exemption', async () => {
    answerWith([[], [{ n: 17 }]]);
    const result = await runRetentionSweep();

    expect(result.tables.find((t) => t.table === 'job_events')?.heldBack).toBe(17);
  });

  it('runs no statement at all for a rule that states no window', async () => {
    answerWith([]);
    const result = await runRetentionSweep();
    const unswept = result.tables.filter((t) => t.windowDays === null);

    expect(unswept.map((t) => t.table)).toEqual(['mcp_audit_log', 'agent_session_turns']);
    for (const table of unswept) {
      expect(table).toMatchObject({ deleted: 0, heldBack: 0 });
    }
  });
});

describe('retention sweep: reporting', () => {
  it('logs one line per table carrying what it deleted and what it held', async () => {
    answerWith([]);
    await runRetentionSweep();

    const lines = infoMock.mock.calls.filter((c) => String(c[1]).startsWith('retention: '));
    expect(lines).toHaveLength(RETENTION_RULES.length);
    for (const [payload] of lines) {
      expect(payload).toHaveProperty('deleted');
      expect(payload).toHaveProperty('heldBack');
      expect(payload).toHaveProperty('windowDays');
      expect(payload).toHaveProperty('durationMs');
    }
  });

  // cm:guard an override that is silently clamped is a window nobody set and nobody can see. The refusal has to reach the log, naming the variable, or the operator reads their own number back off the config and the sweep uses a different one.
  it('warns, naming the variable, when it refuses an override below the floor', async () => {
    process.env.RETENTION_JOB_EVENTS_DAYS = '1';
    answerWith([]);
    try {
      const result = await runRetentionSweep();
      const jobEvents = result.tables.find((t) => t.table === 'job_events');

      expect(jobEvents?.windowDays).toBe(7);
      expect(jobEvents?.rejected).toContain('RETENTION_JOB_EVENTS_DAYS');
      expect(warnMock).toHaveBeenCalledWith(
        expect.objectContaining({ table: 'job_events' }),
        'retention: environment override refused',
      );
    } finally {
      delete process.env.RETENTION_JOB_EVENTS_DAYS;
    }
  });
});

describe('retention sweep: the repair bound', () => {
  it('attempts nothing when the bound is zero', async () => {
    answerWith([]);
    const result = await runRetentionSweep();

    expect(result.repair.attempted).toBe(0);
    expect(deriveMock).not.toHaveBeenCalled();
  });

  it('stamps the attempt before deriving, for every candidate', async () => {
    process.env.RETENTION_FINALIZE_REPAIR_MAX = '2';
    const candidates = [
      { job_id: 'j1', session_id: 's1' },
      { job_id: 'j2', session_id: 's2' },
    ];
    const order: string[] = [];
    executeMock.mockImplementation(async (statement: unknown) => {
      const text = JSON.stringify(statement);
      if (text.includes('agent_session_id AS session_id')) return candidates;
      if (text.includes('UPDATE agent_sessions')) {
        order.push('stamp');
        return [];
      }
      return [];
    });
    deriveMock.mockImplementation(async () => {
      order.push('derive');
    });

    const result = await runRetentionSweep();

    expect(result.repair.attempted).toBe(2);
    expect(order).toEqual(['stamp', 'derive', 'stamp', 'derive']);
  });
});
