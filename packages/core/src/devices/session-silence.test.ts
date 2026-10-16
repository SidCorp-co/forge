import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_IDLE_CLOSE_MS,
  ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
} from '../jobs/loop-monitor-thresholds.js';
import { type SilenceSubject, silenceLimitMs } from './session-silence.js';

const MIN = 60_000;
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
  over: { runnerSeenAt?: number | null; parked?: boolean; runStartedAt?: number } = {},
) => ({
  runStartedAt: over.runStartedAt ?? T - 60 * MIN,
  sessions: [{ beatAt: T, runnerSeenAt: over.runnerSeenAt ?? null, parked: over.parked ?? false }],
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
    expect(silenceLimitMs(subject({ kind: 'master', latestChildBeatAt: T + 4 * MIN }))).toBe(
      14 * MIN,
    );
    expect(silenceLimitMs(subject({ kind: 'master', latestChildBeatAt: T - 4 * MIN }))).toBe(
      10 * MIN,
    );
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
      sessions: [...alone().sessions, { beatAt: T + 90_000, runnerSeenAt: null, parked: false }],
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

  it('states no limit where no reaper ends the session for silence', () => {
    expect(silenceLimitMs(subject({}))).toBeNull();
    expect(silenceLimitMs(subject({ kind: 'run_session', status: 'completed' }))).toBeNull();
  });
});
