import { afterEach, describe, expect, it } from 'vitest';
import {
  getLoopThresholds,
  ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
} from '../jobs/loop-monitor-thresholds.js';
import {
  type OneShotSibling,
  SESSION_SILENCE_TIMEOUT_MS,
  silenceLimitMs,
} from './session-silence.js';

const oneShot = (sessions: OneShotSibling[]) => ({ runStartLeadMs: -60 * 60_000, sessions });

// ISS-1228 round 9: a screen that says when core will end a quiet session counts to the silence
// core ends that kind of session after, read here from the constants the reapers themselves use.
describe('silenceLimitMs', () => {
  const saved = process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
    else process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = saved;
  });

  it('gives a run session and a master the run and master reapers ten minutes', () => {
    expect(silenceLimitMs({ kind: 'run_session' })).toBe(10 * 60_000);
    expect(silenceLimitMs({ kind: 'master', runtimeState: 'awaiting_input' })).toBe(
      SESSION_SILENCE_TIMEOUT_MS,
    );
  });

  it("gives a pipeline or PM session the loop monitor's heartbeat timeout", () => {
    expect(silenceLimitMs({ kind: 'pipeline' })).toBe(getLoopThresholds().heartbeatMs);
    expect(silenceLimitMs({ kind: 'pm', runtimeState: 'working' })).toBe(3 * 60_000);
  });

  it("follows the loop monitor's environment override, as the reaper does", () => {
    process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = String(7 * 60_000);
    expect(silenceLimitMs({ kind: 'pipeline' })).toBe(7 * 60_000);
  });

  it('gives a chat carrying an escalation or an agent chat the heartbeat timeout too', () => {
    expect(silenceLimitMs({ kind: 'chat', metadata: { escalation: { at: 'x' } } })).toBe(
      3 * 60_000,
    );
    expect(silenceLimitMs({ kind: 'chat', metadata: { agentChat: { id: 'a' } } })).toBe(3 * 60_000);
    // The reaper reads `metadata -> 'escalation' IS NOT NULL`, which a JSON null satisfies.
    expect(silenceLimitMs({ kind: 'chat', metadata: { escalation: null } })).toBe(3 * 60_000);
    expect(silenceLimitMs({ kind: 'chat', metadata: { agentChat: null } })).toBe(3 * 60_000);
  });

  it('takes the shortest reaper that applies: a run session carrying an escalation ends at three minutes', () => {
    expect(silenceLimitMs({ kind: 'run_session', metadata: { escalation: null } })).toBe(
      3 * 60_000,
    );
    expect(
      silenceLimitMs({
        kind: 'master',
        runtimeState: 'awaiting_input',
        metadata: { agentChat: {} },
      }),
    ).toBe(10 * 60_000);
  });

  it('waits out a master as long as a child it owns was heard later, as the master reaper does', () => {
    expect(silenceLimitMs({ kind: 'master', childLeadMs: 4 * 60_000 })).toBe(14 * 60_000);
    expect(silenceLimitMs({ kind: 'master', childLeadMs: null })).toBe(10 * 60_000);
  });

  it('ends a session on a jobless one-shot run at the heartbeat timeout unless its runner answers', () => {
    const alone = oneShot([{ leadMs: 0, runnerAnswers: false, parked: false }]);
    expect(silenceLimitMs({ kind: 'run_session', oneShot: alone })).toBe(3 * 60_000);
    expect(silenceLimitMs({ kind: 'chat', oneShot: alone })).toBe(3 * 60_000);
    expect(silenceLimitMs({ kind: 'chat', runtimeState: 'awaiting_input', oneShot: alone })).toBe(
      3 * 60_000,
    );
    const answered = oneShot([{ leadMs: 0, runnerAnswers: true, parked: false }]);
    expect(silenceLimitMs({ kind: 'chat', oneShot: answered })).toBe(
      ONE_SHOT_DEVICE_GRACE_FLOOR_MS,
    );
    expect(silenceLimitMs({ kind: 'run_session', oneShot: answered })).toBe(10 * 60_000);
  });

  it('counts the one-shot sweep from the latest live session on the run, and not at all while a person is asked', () => {
    const siblings = oneShot([
      { leadMs: 0, runnerAnswers: false, parked: false },
      { leadMs: 90_000, runnerAnswers: false, parked: false },
    ]);
    expect(silenceLimitMs({ kind: 'chat', oneShot: siblings })).toBe(3 * 60_000 + 90_000);
    const asked = oneShot([{ leadMs: 0, runnerAnswers: false, parked: true }]);
    expect(silenceLimitMs({ kind: 'chat', oneShot: asked })).toBeNull();
    expect(silenceLimitMs({ kind: 'run_session', oneShot: asked })).toBe(10 * 60_000);
  });

  it('waits for the run to be a heartbeat old before the one-shot sweep may take it', () => {
    const young = {
      runStartLeadMs: 2 * 60_000,
      sessions: [{ leadMs: 0, runnerAnswers: false, parked: false }],
    };
    expect(silenceLimitMs({ kind: 'run_session', oneShot: young })).toBe(5 * 60_000);
  });

  it('states no limit where no silence ends the session', () => {
    expect(silenceLimitMs({ kind: 'chat' })).toBeNull();
    expect(silenceLimitMs({ kind: 'chat', metadata: { other: 1 } })).toBeNull();
    expect(silenceLimitMs({ kind: 'pipeline', runtimeState: 'awaiting_input' })).toBeNull();
    expect(silenceLimitMs({ kind: 'chat', oneShot: oneShot([]) })).toBeNull();
    expect(silenceLimitMs({ kind: 'chat', oneShot: null })).toBeNull();
  });
});
