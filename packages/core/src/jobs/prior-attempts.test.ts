import { describe, expect, it } from 'vitest';
import { JOB_PANE_PREFIX, renderPriorAttemptsBlock } from './prior-attempts.js';

// ISS-1351 (FB-760): attempt 2 of a release was handed out while attempt 1's pane still deployed, and
// its brief never named that pane. A retry's brief names the earlier attempt's pane and has the new
// session confirm it ended before it pushes, tags, deploys or finishes.
describe('a retry’s brief names the pane of the attempt it retries (ISS-1351)', () => {
  const earlier = {
    jobId: 'job-attempt-1',
    attempt: 1,
    sessionId: 'session-1',
    messageCount: 12,
    failureReason: "the job's pane ended without reporting an outcome",
    salvage: null,
  };

  it('names the earlier pane by the name the box runs it under', () => {
    const block = renderPriorAttemptsBlock([earlier], 2);
    expect(block).toContain(`\`${JOB_PANE_PREFIX}job-attempt-1\``);
    expect(block).toContain(`tmux has-session -t =${JOB_PANE_PREFIX}job-attempt-1`);
  });

  it('has the new session act on nothing while that pane stands', () => {
    const block = renderPriorAttemptsBlock([earlier], 2);
    expect(block).toContain('Before you push, tag, deploy or call `finish`');
    expect(block).toContain('end your turn saying so');
  });

  it('says nothing where there is no earlier attempt', () => {
    expect(renderPriorAttemptsBlock([], 1)).toBe('');
  });
});
