import {
  MASTER_JOB_PANES_MAX,
  type MasterClosedPass,
  type MasterOpenPass,
  masterPassRequestSchema,
  masterSessionRequestSchema,
} from '@forge/contracts/master-standing';
import { describe, expect, it } from 'vitest';
import {
  NO_MASTER_SLOTS,
  passAlreadyOpenRefusal,
  passNotOpenRefusal,
  sessionEndedRefusal,
  slotsNoteOf,
  slotsOf,
  slotsUndeclaredRefusal,
} from './rules.js';

const open: MasterOpenPass = {
  id: 'p1',
  sessionId: 's1',
  verb: 'dispatch',
  startedAt: '2026-10-04T08:00:00.000Z',
  issueKey: 'ISS-1414',
};
const closed: MasterClosedPass = {
  ...open,
  endedAt: '2026-10-04T08:02:00.000Z',
  dispatched: ['ISS-1413'],
  skipped: [{ issueKey: 'ISS-1405', refusal: 'ISS-1402 blocks it' }],
  parked: [],
};

describe('edge master.declared: a master session declares its slots', () => {
  it('a session that declares no maxJobPanes is MASTER_SLOTS_UNDECLARED, naming the field and the valid range', () => {
    const refusal = slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion: '0.18.0' });
    expect(refusal?.code).toBe('MASTER_SLOTS_UNDECLARED');
    expect(refusal?.path).toBe('/maxJobPanes');
    expect(refusal?.detail).toContain(`1 to ${MASTER_JOB_PANES_MAX}`);
    expect(refusal?.detail).toContain('no default');
  });

  it('a box whose version core cannot read gets no amnesty: unknown is refused, never guessed old', () => {
    expect(slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion: null })?.code).toBe(
      'MASTER_SLOTS_UNDECLARED',
    );
    expect(
      slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion: '0.17.0-dev' })?.code,
    ).toBe('MASTER_SLOTS_UNDECLARED');
  });

  it('a declared count passes at both ends of its range', () => {
    expect(slotsUndeclaredRefusal({ maxJobPanes: 1, agentVersion: '0.18.0' })).toBeNull();
    expect(
      slotsUndeclaredRefusal({ maxJobPanes: MASTER_JOB_PANES_MAX, agentVersion: null }),
    ).toBeNull();
  });

  it('a runner of any version that declares no maxJobPanes is refused: the ISS-107 amnesty is over', () => {
    for (const agentVersion of ['0.17.0', '0.17.90', '0.18.0', '1.0.0']) {
      expect(
        slotsUndeclaredRefusal({ maxJobPanes: undefined, agentVersion })?.code,
        agentVersion,
      ).toBe('MASTER_SLOTS_UNDECLARED');
    }
  });

  it('the body takes maxJobPanes from 1 to the cap and refuses zero, the cap plus one, a fraction and a stray field', () => {
    const ok = { projectId: '8a7c4b5e-3f2d-4c1b-9a8e-7d6c5b4a3f2e', name: 'forge-master' };
    expect(masterSessionRequestSchema.safeParse({ ...ok, maxJobPanes: 1 }).success).toBe(true);
    expect(masterSessionRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [0, MASTER_JOB_PANES_MAX + 1, 2.5, '3']) {
      expect(
        masterSessionRequestSchema.safeParse({ ...ok, maxJobPanes: bad }).success,
        String(bad),
      ).toBe(false);
    }
    expect(masterSessionRequestSchema.safeParse({ ...ok, slots: 3 }).success).toBe(false);
  });
});

describe('region master: a pass is opened and closed by the runner', () => {
  it('a second open is MASTER_PASS_ALREADY_OPEN, naming the pass that is open', () => {
    expect(passAlreadyOpenRefusal(null)).toBeNull();
    const refusal = passAlreadyOpenRefusal(open);
    expect(refusal?.code).toBe('MASTER_PASS_ALREADY_OPEN');
    expect(refusal?.detail).toContain('dispatch pass');
    expect(refusal?.detail).toContain('ISS-1414');
  });

  it('a close of a pass that is not open is MASTER_PASS_NOT_OPEN: a replay names the ended pass and the one open now', () => {
    const replay = passNotOpenRefusal({
      passId: closed.id,
      named: closed,
      open: { ...open, id: 'p2' },
    });
    expect(replay.code).toBe('MASTER_PASS_NOT_OPEN');
    expect(replay.path).toBe('/passId');
    expect(replay.detail).toContain(closed.endedAt);
    expect(replay.detail).toContain('changed nothing');
    expect(replay.detail).toContain('id p2');
    const unknown = passNotOpenRefusal({ passId: 'p9', named: null, open: null });
    expect(unknown.code).toBe('MASTER_PASS_NOT_OPEN');
    expect(unknown.detail).toContain('no pass p9');
    expect(unknown.detail).toContain('No pass is open');
  });

  it('a pass on a master that has ended is MASTER_SESSION_ENDED; a live one opens', () => {
    expect(sessionEndedRefusal('running', false)).toBeNull();
    const refusal = sessionEndedRefusal('failed', true);
    expect(refusal?.code).toBe('MASTER_SESSION_ENDED');
    expect(refusal?.detail).toContain('failed');
  });

  it('the pass body is one of two shapes, each strict, with the verb from the closed set', () => {
    const sessionId = '8a7c4b5e-3f2d-4c1b-9a8e-7d6c5b4a3f2e';
    expect(masterPassRequestSchema.safeParse({ op: 'open', sessionId, verb: 'fold' }).success).toBe(
      true,
    );
    expect(
      masterPassRequestSchema.safeParse({ op: 'open', sessionId, verb: 'sweep' }).success,
    ).toBe(false);
    expect(
      masterPassRequestSchema.safeParse({
        op: 'close',
        sessionId,
        passId: sessionId,
        dispatched: [],
        skipped: [],
        parked: [],
      }).success,
    ).toBe(true);
    expect(
      masterPassRequestSchema.safeParse({
        op: 'close',
        sessionId,
        dispatched: [],
        skipped: [],
        parked: [],
      }).success,
      'a close names the pass it closes',
    ).toBe(false);
    expect(
      masterPassRequestSchema.safeParse({ op: 'close', sessionId, dispatched: [] }).success,
    ).toBe(false);
    expect(
      masterPassRequestSchema.safeParse({
        op: 'close',
        sessionId,
        passId: sessionId,
        dispatched: [],
        skipped: [{ issueKey: 'ISS-1' }],
        parked: [],
      }).success,
    ).toBe(false);
    expect(
      masterPassRequestSchema.safeParse({ op: 'open', sessionId, verb: 'fold', dispatched: [] })
        .success,
    ).toBe(false);
  });
});

describe('masters/standing slots: max is what the box declared, never a default', () => {
  it('a device that declared none serves max null and says it is undeclared', () => {
    const slots = slotsOf({ name: 'box-1', maxJobPanes: null }, 2);
    expect(slots.inUse).toBe(2);
    expect(slots.max).toBeNull();
    expect(slots.undeclared?.code).toBe('MASTER_SLOTS_UNDECLARED');
    expect(slots.undeclared?.detail).toContain('box-1');
    expect(slotsNoteOf({ slots })).toBe(slots.undeclared?.detail);
  });

  it('a declared device serves its number and no note; no master serves no slots and says why', () => {
    const slots = slotsOf({ name: 'box-1', maxJobPanes: 3 }, 0);
    expect(slots).toEqual({ inUse: 0, max: 3, undeclared: null });
    expect(slotsNoteOf({ slots })).toBeNull();
    expect(slotsNoteOf({ slots: null })).toBe(NO_MASTER_SLOTS);
  });
});
