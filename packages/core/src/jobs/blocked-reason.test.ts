import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCKED_PHRASE, isBlockedReason } from './blocked-reason.js';

const RUNNER_SOURCE = fileURLToPath(
  new URL('../../../runner/crates/forge-runner-core/src/daemon/job_exit.rs', import.meta.url),
);

describe('the blocked reason', () => {
  it('is one string on both sides: the runner constant and the phrase core recognises', () => {
    const source = readFileSync(RUNNER_SOURCE, 'utf8');
    const declared = source.match(/pub const BLOCKED_PHRASE: &str = "([^"]+)";/);
    expect(declared, 'job_exit.rs declares BLOCKED_PHRASE on one line').not.toBeNull();
    expect(declared?.[1]).toBe(BLOCKED_PHRASE);
  });

  it('is what the runner writes into the reason it ends a blocked pane with', () => {
    const source = readFileSync(RUNNER_SOURCE, 'utf8');
    expect(source).toContain('has been {BLOCKED_PHRASE} for');
  });

  it('recognises a reason carrying it and no other', () => {
    expect(
      isBlockedReason(
        `the job's pane \`forge-job-1\` has been ${BLOCKED_PHRASE} for 15m — nothing answers`,
      ),
    ).toBe(true);
    expect(isBlockedReason('the job exceeded its timeout')).toBe(false);
    expect(isBlockedReason('')).toBe(false);
  });
});
