import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_IDLE_CLOSE_MS,
  ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
} from '../jobs/loop-monitor-thresholds.js';
import { endsOnItsOwnClock } from '../jobs/session-kinds.js';
import { type SilenceSubject, silenceDeadline, silenceLimitFrom } from './session-silence.js';

const MIN = 60_000;

const silenceLimitMs = (s: SilenceSubject) =>
  silenceLimitFrom(silenceDeadline(s), s.lastHeartbeatAt, s.startedAt, s.updatedAt);
const T = Date.parse('2026-10-16T12:00:00Z');

/** A running session heard at T, started a minute before, with nothing else about it. */
function subject(over: Partial<SilenceSubject>): SilenceSubject {
  return {
    kind: 'chat',
    status: 'running',
    runtimeState: 'working',
    hasClient: true,
    lastHeartbeatAt: T,
    startedAt: T - MIN,
    updatedAt: T,
    createdAt: T - MIN,
    hasJob: true,
    residencyMs: 15 * MIN,
    ...over,
  };
}

const alone = (
  over: {
    runnerSeenAt?: number | null;
    runnerAnswers?: boolean;
    parked?: boolean;
    runStartedAt?: number;
    ownClock?: boolean;
  } = {},
) => ({
  runStartedAt: over.runStartedAt ?? T - 60 * MIN,
  sessions: [
    {
      ownClock: over.ownClock ?? false,
      beatAt: T,
      runnerSeenAt: over.runnerSeenAt ?? null,
      runnerAnswers: over.runnerAnswers ?? false,
      parked: over.parked ?? false,
      endsBy: null,
    },
  ],
});

// ISS-1228 round 9: the limit a screen counts to is the earliest moment any reaper ends the session,
// each read with its own eligibility and its own baseline.
describe('silenceLimitMs', () => {
  const saved = process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
    else process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = saved;
  });

  it('gives a running run session ten minutes, and a master ten past its latest child', () => {
    expect(silenceLimitMs(subject({ kind: 'run_session' }))).toBe(10 * MIN);
    expect(
      silenceLimitMs(subject({ kind: 'master', runtimeState: 'awaiting_input', parked: true })),
    ).toBe(10 * MIN);
    const child = (beatAt: number | null, endsBy: number | null = null) => ({ beatAt, endsBy });
    expect(silenceLimitMs(subject({ kind: 'master', children: [child(T + 4 * MIN)] }))).toBe(
      14 * MIN,
    );
    expect(silenceLimitMs(subject({ kind: 'master', children: [child(T - 4 * MIN)] }))).toBe(
      10 * MIN,
    );
    // A child that never reported holds nothing; one another reaper ends holds only until then.
    expect(silenceLimitMs(subject({ kind: 'master', children: [child(null)] }))).toBe(10 * MIN);
    expect(
      silenceLimitMs(subject({ kind: 'master', children: [child(T + 4 * MIN, T + 2 * MIN)] })),
    ).toBe(10 * MIN);
    expect(
      silenceLimitMs(subject({ kind: 'master', children: [child(T + 4 * MIN, T + 12 * MIN)] })),
    ).toBe(12 * MIN);
  });

  it("gives a pipeline session the loop monitor's heartbeat timeout, following its override", () => {
    expect(silenceLimitMs(subject({ kind: 'pipeline' }))).toBe(3 * MIN);
    process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = String(7 * MIN);
    expect(silenceLimitMs(subject({ kind: 'pm' }))).toBe(7 * MIN);
  });

  it('counts the heartbeat hop from the later of start and update where no heartbeat came', () => {
    const quiet = subject({
      kind: 'pipeline',
      lastHeartbeatAt: null,
      startedAt: T - 4 * MIN,
      updatedAt: T - MIN,
    });
    expect(silenceLimitMs(quiet)).toBe(6 * MIN);
  });

  it('gives a chat carrying an escalation or an agent chat key the heartbeat timeout, a JSON null included', () => {
    for (const metadata of [{ escalation: null }, { agentChat: {} }]) {
      expect(silenceLimitMs(subject({ metadata }))).toBe(3 * MIN);
    }
    expect(silenceLimitMs(subject({ kind: 'run_session', metadata: { escalation: null } }))).toBe(
      3 * MIN,
    );
  });

  it('ends an unparked waiting session at its residency, and a parked one not at all by it', () => {
    expect(silenceLimitMs(subject({ kind: 'pipeline', runtimeState: 'awaiting_input' }))).toBe(
      15 * MIN,
    );
    expect(
      silenceLimitMs(subject({ kind: 'pipeline', runtimeState: 'awaiting_input', parked: true })),
    ).toBeNull();
  });

  it('closes a live session no job names after two hours, a scheduled run excepted', () => {
    expect(silenceLimitMs(subject({ hasJob: false }))).toBe(CHAT_IDLE_CLOSE_MS);
    expect(
      silenceLimitMs(subject({ hasJob: false, metadata: { source: 'schedule.run' } })),
    ).toBeNull();
    expect(silenceLimitMs(subject({ hasJob: false, startedAt: null }))).toBeNull();
  });

  it('ends a chat no client attached to at the heartbeat timeout, or the fast ack line once acked', () => {
    expect(silenceLimitMs(subject({ hasClient: false }))).toBe(3 * MIN);
    const acked = subject({ hasClient: false, metadata: { acked: true }, dispatchedAt: T - MIN });
    expect(silenceLimitMs(acked)).toBe(30_000);
  });

  it('ends a queued pipeline session at the queue timeout from its dispatch', () => {
    const queued = subject({
      kind: 'pipeline',
      status: 'queued',
      lastHeartbeatAt: null,
      startedAt: null,
      updatedAt: T,
      createdAt: T - 30_000,
      dispatchedAt: T - 30_000,
    });
    expect(silenceLimitMs(queued)).toBe(90_000);
  });
});

describe('silenceLimitMs on a one-shot run', () => {
  const saved = process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
    else process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = saved;
  });

  it('ends a session on a jobless one-shot run at the heartbeat timeout unless its runner answers', () => {
    expect(silenceLimitMs(subject({ kind: 'run_session', oneShot: alone() }))).toBe(3 * MIN);
    expect(silenceLimitMs(subject({ oneShot: alone({ runnerSeenAt: T + 60 * MIN }) }))).toBe(
      ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
    );
    expect(
      silenceLimitMs(
        subject({ kind: 'run_session', oneShot: alone({ runnerSeenAt: T + 60 * MIN }) }),
      ),
    ).toBe(10 * MIN);
  });

  // ISS-1228 round 11 (judge-27): a box that keeps answering moved the published end three minutes
  // past its latest answer on every reading, so a screen counted "2m 59s" for six minutes.
  it('publishes one end for a session whose box keeps answering, however late its latest answer', () => {
    const run = (seen: number) =>
      silenceDeadline(
        subject({
          kind: 'run_session',
          oneShot: alone({ runnerSeenAt: seen, runnerAnswers: true }),
        }),
      );
    expect(run(T + MIN)).toBe(run(T + 6 * MIN));
    expect(run(T + MIN)).toBe(T + 10 * MIN);
    const chat = (seen: number) =>
      silenceDeadline(subject({ oneShot: alone({ runnerSeenAt: seen, runnerAnswers: true }) }));
    expect(chat(T + MIN)).toBe(chat(T + 15 * MIN));
    expect(chat(T + MIN)).toBe(T + ONE_SHOT_DEVICE_GRACE_FLOOR_MS);
  });

  it('keeps both bounds once the box stops answering: its last answer, never past the grace, never before the beat', () => {
    // Heard at minute 0, its box last at minute 19 and silent since: the sweep may take it at 20.
    expect(silenceDeadline(subject({ oneShot: alone({ runnerSeenAt: T + 19 * MIN }) }))).toBe(
      T + ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
    );
    // Its box last heard before the session itself: the session's own beat plus three minutes.
    expect(silenceDeadline(subject({ oneShot: alone({ runnerSeenAt: T - 2 * MIN }) }))).toBe(
      T + 3 * MIN,
    );
  });

  it("holds the runner's grace only while the runner's own last word is within the heartbeat timeout", () => {
    expect(silenceLimitMs(subject({ oneShot: alone({ runnerSeenAt: T + 2 * MIN }) }))).toBe(
      5 * MIN,
    );
    expect(silenceLimitMs(subject({ oneShot: alone({ runnerSeenAt: T - 10 * MIN }) }))).toBe(
      3 * MIN,
    );
  });

  it('counts the one-shot sweep from the run start and the latest live session on it, never while a person is asked', () => {
    expect(silenceLimitMs(subject({ oneShot: alone({ runStartedAt: T + 2 * MIN }) }))).toBe(
      5 * MIN,
    );
    const two = {
      runStartedAt: T - 60 * MIN,
      sessions: [
        ...alone().sessions,
        {
          ownClock: false,
          beatAt: T + 90_000,
          runnerSeenAt: null,
          runnerAnswers: false,
          parked: false,
          endsBy: null,
        },
      ],
    };
    expect(silenceLimitMs(subject({ oneShot: two }))).toBe(3 * MIN + 90_000);
    expect(silenceLimitMs(subject({ oneShot: alone({ parked: true }) }))).toBeNull();
    expect(silenceLimitMs(subject({ kind: 'run_session', oneShot: alone({ parked: true }) }))).toBe(
      10 * MIN,
    );
  });

  it('reads zero, never a negative, where a reaper counts from before the moment the screens count from', () => {
    const late = subject({
      kind: 'pipeline',
      runtimeState: 'awaiting_input',
      lastHeartbeatAt: null,
      createdAt: T - 60 * MIN,
      startedAt: T,
    });
    expect(silenceLimitMs(late)).toBe(0);
  });

  it('lets a sibling hold the one-shot sweep off only until another reaper ends that sibling', () => {
    const run = (endsBy: number | null, parked = false) => ({
      runStartedAt: T - 60 * MIN,
      sessions: [
        ...alone().sessions,
        {
          ownClock: false,
          beatAt: T,
          runnerSeenAt: T + 10 * MIN,
          runnerAnswers: false,
          parked,
          endsBy,
        },
      ],
    });
    expect(silenceLimitMs(subject({ oneShot: run(null) }))).toBe(13 * MIN);
    expect(silenceLimitMs(subject({ oneShot: run(T + MIN) }))).toBe(3 * MIN);
    expect(silenceLimitMs(subject({ oneShot: run(T + 5 * MIN, true) }))).toBe(5 * MIN);
    expect(silenceLimitMs(subject({ oneShot: run(null, true) }))).toBeNull();
  });

  it('counts from the row the screen is served, so a beat landing after it only lengthens the limit', () => {
    const deadline = silenceDeadline(subject({ kind: 'pipeline', lastHeartbeatAt: T + MIN }));
    expect(silenceLimitFrom(deadline, new Date(T))).toBe(4 * MIN);
    expect(silenceLimitFrom(deadline, null, new Date(T - MIN).toISOString())).toBe(5 * MIN);
    expect(silenceLimitFrom(deadline, null, undefined)).toBeNull();
    expect(silenceLimitFrom(null, T)).toBeNull();
  });

  it('states no limit where no reaper ends the session for silence', () => {
    expect(silenceLimitMs(subject({}))).toBeNull();
    expect(silenceLimitMs(subject({ kind: 'run_session', status: 'completed' }))).toBeNull();
  });
});

describe('one end for a session its own reaper ends', () => {
  // ISS-1228 round 14 (judge-36): the sweep took a run session three minutes after its box's last
  // answer, so the countdown fell from 8m 44s to 1m 20s the moment the box went silent.
  it('publishes one end for a run session or a master, ten minutes from its own beat, whatever its box does', () => {
    for (const kind of ['run_session', 'master']) {
      const end = (seen: number | null, answers: boolean) =>
        silenceDeadline(
          subject({
            kind,
            oneShot: alone({ runnerSeenAt: seen, runnerAnswers: answers, ownClock: true }),
          }),
        );
      expect(end(T + MIN, true)).toBe(T + 10 * MIN);
      expect(end(T + 20_000, false)).toBe(T + 10 * MIN);
      expect(end(null, false)).toBe(T + 10 * MIN);
    }
  });
});

describe('endsOnItsOwnClock', () => {
  it('names a running run session and a master of any status, which their own reapers end', () => {
    expect(endsOnItsOwnClock('run_session', 'running')).toBe(true);
    expect(endsOnItsOwnClock('master', 'idle')).toBe(true);
    // The run-session reaper reads only a running one, so the sweep keeps every other.
    expect(endsOnItsOwnClock('run_session', 'queued')).toBe(false);
    expect(endsOnItsOwnClock('chat', 'running')).toBe(false);
  });

  // ISS-1228 round 17 (judge-45): a chat waiting on its person's reply was failed by the one-shot
  // sweep twenty quiet minutes after its turn ended, with no countdown before.
  it('names a chat waiting on its person, which only the idle-chat close ends', () => {
    expect(endsOnItsOwnClock('chat', 'idle')).toBe(true);
    const waiting = subject({
      status: 'idle',
      runtimeState: null,
      hasJob: false,
      oneShot: alone({
        runnerSeenAt: T + 60 * MIN,
        runnerAnswers: true,
        ownClock: endsOnItsOwnClock('chat', 'idle'),
      }),
    });
    expect(silenceLimitMs(waiting)).toBe(CHAT_IDLE_CLOSE_MS);
  });
});
