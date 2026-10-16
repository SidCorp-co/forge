import { afterEach, describe, expect, it } from 'vitest';
import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { SESSION_SILENCE_TIMEOUT_MS, silenceLimitMs } from './session-silence.js';

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
  });

  it('states no limit where no silence ends the session', () => {
    expect(silenceLimitMs({ kind: 'chat' })).toBeNull();
    expect(silenceLimitMs({ kind: 'chat', metadata: { escalation: null } })).toBeNull();
    expect(silenceLimitMs({ kind: 'pipeline', runtimeState: 'awaiting_input' })).toBeNull();
  });
});
