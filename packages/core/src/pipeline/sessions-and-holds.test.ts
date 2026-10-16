import type { IssuePark } from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { classifyLease } from './session-claim.js';
import {
  type ClaimInput,
  type LeaseRow,
  type PersonInput,
  personHolderFromPark,
  projectSessionsAndHolds,
  type SessionRow,
} from './sessions-and-holds.js';

const NOW = new Date('2026-10-15T02:00:00.000Z');

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 's-run',
  kind: 'run_session',
  title: 'run: ISS-7',
  status: 'running',
  runtime_state: 'working',
  device_id: 'd-1',
  device_name: 'box-a',
  parent_session_id: 's-master',
  started_at: '2026-10-15T01:00:00.000Z',
  last_heartbeat_at: '2026-10-15T01:59:30.000Z',
  created_at: '2026-10-15T01:00:00.000Z',
  ...over,
});

const lease = (over: Partial<LeaseRow> = {}): LeaseRow => ({
  session_id: 's-run',
  session_title: 'run: ISS-7',
  session_kind: 'run_session',
  device_name: 'box-a',
  acquired_at: '2026-10-15T01:00:05.000Z',
  issue_id: 'i-7',
  iss_seq: 7,
  title: 'Seven',
  status: 'in_progress',
  held: true,
  ...over,
});

const claim = (blob: Record<string, unknown>, fanout = 1): ClaimInput => ({
  issue: { id: 'i-8', iss_seq: 8, title: 'Eight', status: 'in_progress' },
  lease: blob,
  reading: classifyLease({ lease: blob, now: NOW, fanout }),
});

const liveBlob = {
  holder: 'iss-8-abc',
  renewedAt: '2026-10-15T01:50:00.000Z',
  minutes: 60,
  next: 'build the route',
};

const project = (over: Partial<Parameters<typeof projectSessionsAndHolds>[0]> = {}) =>
  projectSessionsAndHolds({
    prefix: 'FRG',
    sessions: [],
    ledger: [],
    leases: [],
    claims: [],
    persons: [],
    now: NOW,
    ...over,
  });

describe('projectSessionsAndHolds — sessions', () => {
  it('gives each live session the issues it holds and the box report it last sent', () => {
    const out = project({
      sessions: [session()],
      leases: [lease()],
      ledger: [
        {
          session_id: 's-run',
          incarnation: 'live',
          work: 'blocked',
          blocker_kind: 'human',
          waiting_on: 'an answer on ISS-7',
          observed_at: '2026-10-15T01:58:00.000Z',
          work_since: '2026-10-15T01:50:00.000Z',
        },
      ],
    });
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]?.issues).toEqual([
      { issueId: 'i-7', displayId: 'FRG-7', title: 'Seven' },
    ]);
    expect(out.sessions[0]?.report).toEqual({
      incarnation: 'live',
      work: 'blocked',
      blockerKind: 'human',
      waitingOn: 'an answer on ISS-7',
      observedAt: '2026-10-15T01:58:00.000Z',
      since: '2026-10-15T01:50:00.000Z',
    });
    expect(out.readAt).toBe(NOW.toISOString());
  });

  it('names an issue whose lease the run reports returned, and holds nothing for it', () => {
    const out = project({ sessions: [session()], leases: [lease({ held: false })] });
    expect(out.sessions[0]?.issues.map((i) => i.issueId)).toEqual(['i-7']);
    expect(out.holds).toEqual([]);
  });

  it('keeps the newest of two ledger entries for one session', () => {
    const entry = {
      session_id: 's-run',
      incarnation: 'live',
      blocker_kind: null,
      waiting_on: null,
      work_since: '2026-10-15T01:00:00.000Z',
    };
    const out = project({
      sessions: [session()],
      ledger: [
        { ...entry, work: 'runnable', observed_at: '2026-10-15T01:59:00.000Z' },
        { ...entry, work: 'blocked', observed_at: '2026-10-15T01:10:00.000Z' },
      ],
    });
    expect(out.sessions[0]?.report?.work).toBe('runnable');
  });

  it('reports no box report rather than an empty one where the box sent none', () => {
    expect(project({ sessions: [session()] }).sessions[0]?.report).toBeNull();
  });

  it('renders the legacy prefix where the project holds none', () => {
    const out = project({ prefix: null, sessions: [session()], leases: [lease()] });
    expect(out.sessions[0]?.issues[0]?.displayId).toBe('ISS-7');
  });

  it('answers an empty project with empty lists, not a refusal', () => {
    expect(project()).toEqual({ sessions: [], holds: [], readAt: NOW.toISOString() });
  });
});

describe('projectSessionsAndHolds — holds', () => {
  it('holds an issue a live session leases, naming the session and its box', () => {
    const [held] = project({ leases: [lease()] }).holds;
    expect(held?.holders).toEqual([
      {
        by: 'session',
        sessionId: 's-run',
        sessionTitle: 'run: ISS-7',
        sessionKind: 'run_session',
        deviceName: 'box-a',
        since: '2026-10-15T01:00:05.000Z',
      },
    ]);
  });

  it('holds an issue under a live claim, carrying its last renewal and next line', () => {
    const [held] = project({ claims: [claim(liveBlob)] }).holds;
    expect(held?.holders).toEqual([
      {
        by: 'claim',
        holder: 'iss-8-abc',
        renewedAt: '2026-10-15T01:50:00.000Z',
        expiresAt: '2026-10-15T02:50:00.000Z',
        next: 'build the route',
      },
    ]);
  });

  it('does not hold an issue whose claim has expired', () => {
    expect(project({ claims: [claim({ ...liveBlob, minutes: 5 })] }).holds).toEqual([]);
  });

  it('does not hold an issue whose claim was stopped', () => {
    expect(
      project({ claims: [claim({ ...liveBlob, stopped: '2026-10-15T01:55:00.000Z' })] }).holds,
    ).toEqual([]);
  });

  it('does not hold an issue whose holder claims several at once, as held-hydrator reads it', () => {
    expect(project({ claims: [claim(liveBlob, 2)] }).holds).toEqual([]);
  });

  it('does not hold an issue under a claim it cannot read', () => {
    expect(
      project({ claims: [claim({ holder: 'x', renewedAt: 'not a time', minutes: 5 })] }).holds,
    ).toEqual([]);
  });

  it('gathers every holder of one issue on one row', () => {
    const person: PersonInput = {
      issue: { id: 'i-7', iss_seq: 7, title: 'Seven', status: 'waiting' },
      holder: { by: 'person', status: 'waiting', owes: null, since: null, why: null },
    };
    const out = project({
      leases: [lease()],
      claims: [
        { ...claim(liveBlob), issue: { id: 'i-7', iss_seq: 7, title: 'Seven', status: 'waiting' } },
      ],
      persons: [person],
    });
    expect(out.holds).toHaveLength(1);
    expect(out.holds[0]?.holders.map((h) => h.by)).toEqual(['session', 'claim', 'person']);
  });
});

describe('personHolderFromPark', () => {
  const park = (over: Partial<IssuePark> = {}): IssuePark => ({
    shape: 'park',
    status: 'needs_info',
    owes: 'decision',
    since: '2026-10-14T10:00:00.000Z',
    reason: 'the move reason',
    resume: { at: null, why: 'x' },
    record: {
      commentId: 'c',
      kind: 'question',
      why: 'the park record why',
      postedAt: '2026-10-14T10:00:00.000Z',
    },
    readings: [],
    answer: null,
    openQuestionIds: [],
    ...over,
  });

  it("takes the park record's why before the move's reason", () => {
    expect(personHolderFromPark('needs_info', park()).why).toBe('the park record why');
  });

  it("falls back to the move's reason where no record was posted", () => {
    expect(personHolderFromPark('needs_info', park({ record: null })).why).toBe('the move reason');
  });

  it('reports no reason, not an invented one, where neither was recorded', () => {
    expect(personHolderFromPark('waiting', park({ record: null, reason: null })).why).toBeNull();
  });

  it('keeps what is owed unknown where the park stored no kind', () => {
    const out = personHolderFromPark(
      'waiting',
      park({ status: 'waiting', owes: null, since: null }),
    );
    expect(out).toMatchObject({ status: 'waiting', owes: null, since: null });
  });

  it('reads a park view that answered nothing as a hold with nothing recorded', () => {
    expect(personHolderFromPark('needs_info', null)).toEqual({
      by: 'person',
      status: 'needs_info',
      owes: null,
      since: null,
      why: null,
    });
  });
});
