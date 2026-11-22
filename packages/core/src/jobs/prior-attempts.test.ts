// @gate-input whole-tree — it runs each taught command under zsh, which the guard cannot see
import { spawnSync } from 'node:child_process';
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
    expect(block).toContain(`tmux has-session -t '=${JOB_PANE_PREFIX}job-attempt-1'`);
  });

  // ISS-1413 (FB-822): a job pane runs zsh, where an unquoted word starting with `=` is filename
  // expansion: `-t =forge-job-<id>` printed "not found" and exited 1 before tmux ran, so a live
  // attempt read as ended and kill-session ended nothing. Each taught command quotes its target, and
  // zsh hands that target to tmux unchanged.
  const taught = (block: string) =>
    [...block.matchAll(/`(tmux (?:has|kill)-session -t [^`]+)`/g)].map((m) => m[1] ?? '');

  it('quotes the exact-match target of every tmux command it teaches', () => {
    const lines = taught(renderPriorAttemptsBlock([earlier], 2));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/-t '=forge-job-[^']+'$/);
  });

  it.skipIf(spawnSync('zsh', ['-fc', 'true']).error !== undefined)(
    'hands each taught target to tmux unchanged when zsh runs it',
    () => {
      for (const line of taught(renderPriorAttemptsBlock([earlier], 2))) {
        const echoed = spawnSync('zsh', ['-fc', line.replace(/^tmux /, 'print -r -- ')], {
          encoding: 'utf8',
        });
        expect(echoed.stderr).toBe('');
        expect(echoed.stdout).toContain(`=${JOB_PANE_PREFIX}job-attempt-1`);
      }
    },
  );

  // ISS-1411 (FB-819): on a box whose runner never ends a failed attempt's pane, "end your turn
  // while it stands" stopped every retry and deadlocked agenfold's 0.307.0 on attempt 8. The retry
  // holds the run, so it ends that pane, which keeps two attempts from acting at once, and goes on.
  it('has the new session end a pane that still stands and go on, never stop on it', () => {
    const block = renderPriorAttemptsBlock([earlier], 2);
    expect(block).toContain('Before you push, tag, deploy or call `finish`');
    expect(block).toContain(`tmux kill-session -t '=${JOB_PANE_PREFIX}job-attempt-1'`);
    expect(block).toContain('then go on');
    expect(block).not.toContain('end your turn');
  });

  it('says nothing where there is no earlier attempt', () => {
    expect(renderPriorAttemptsBlock([], 1)).toBe('');
  });
});
