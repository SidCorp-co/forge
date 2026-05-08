import { describe, expect, it } from 'vitest';
import { classifyJobFailure } from '@/features/pipeline/job-failure';

describe('classifyJobFailure', () => {
  it('classifies "unsupported job type" as runner-skipped', () => {
    const r = classifyJobFailure('unsupported job type or missing issueId (type=test)', 'permanent');
    expect(r.kind).toBe('runner-skipped');
    expect(r.label).toBe('Runner skipped');
    expect(r.tooltip).toMatch(/runner declined/);
  });

  it('classifies "no runner available" as runner-skipped', () => {
    const r = classifyJobFailure('no runner available for project', null);
    expect(r.kind).toBe('runner-skipped');
  });

  it('classifies "stuck dispatched" as watchdog-stalled', () => {
    const r = classifyJobFailure('stuck dispatched > 300s without start (watchdog)', 'transient');
    expect(r.kind).toBe('watchdog-stalled');
    expect(r.label).toBe('Watchdog stalled');
  });

  it('classifies "queued > Ns without dispatch" as watchdog-stalled', () => {
    const r = classifyJobFailure('queued > 600s without dispatch (queued-watchdog)', 'transient');
    expect(r.kind).toBe('watchdog-stalled');
  });

  it('classifies generic agent failure as agent-errored', () => {
    const r = classifyJobFailure('Agent completed with errors', 'unknown');
    expect(r.kind).toBe('agent-errored');
    expect(r.tooltip).toBe('Agent completed with errors');
  });

  it('falls back to watchdog-stalled when error is null and failureKind=transient', () => {
    const r = classifyJobFailure(null, 'transient');
    expect(r.kind).toBe('watchdog-stalled');
  });

  it('falls back to agent-errored when error and failureKind are both null', () => {
    const r = classifyJobFailure(null, null);
    expect(r.kind).toBe('agent-errored');
    expect(r.tooltip).toMatch(/See job event log/);
  });
});
