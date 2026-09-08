/**
 * An advertised protection must exist in this build.
 *
 * A box acts on this list by releasing its process, so a name with nothing
 * behind it is worse than no advertisement: the runner parks, the protection
 * that was promised is absent, and the park is reaped or answered by a second
 * job — exactly the rolling-deploy failure criterion 27 exists to prevent.
 *
 * Read from the SOURCE rather than by calling the reapers, because the claim is
 * "the code is in this build", and a behavioural test of each protection lives
 * with that protection (`processless-park-clocks-e2e`,
 * `answer-resume-parked-run-e2e`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARK_PROTECTIONS } from './protections.js';

const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

// cm:guard each entry names the code the advertisement PROMISES, not a word from the protection's own name — a substring of the name would pass against a file that merely mentions it, which is the tautology this test exists instead of.
const BEHIND: Record<(typeof PARK_PROTECTIONS)[number], { file: string; proof: RegExp }> = {
  'park-exempt-residency': {
    file: 'jobs/park-deadline.ts',
    proof: /NOT EXISTS[\s\S]{0,200}blocker_kind = 'human'/,
  },
  'answer-resume-park': {
    file: 'pipeline/answer-resume.ts',
    proof: /answerReachesAParkedRun/,
  },
};

describe('the park protections core advertises', () => {
  it.each(PARK_PROTECTIONS)('has the code behind %s in this build', (name) => {
    const behind = BEHIND[name];
    expect(behind, `no proof registered for ${name}`).toBeDefined();
    expect(src(behind.file)).toMatch(behind.proof);
  });

  // cm:guard the map and the advertisement must not drift in EITHER direction: a member here with no advertisement is dead, and an advertised name with no member is the empty promise above. Asserted as a set so adding to one alone fails.
  it('advertises exactly the protections it can prove', () => {
    expect(Object.keys(BEHIND).sort()).toEqual([...PARK_PROTECTIONS].sort());
  });

  // cm:guard `worktree-reap-ledger` is the runner's own reaper and must stay OUT of core's list. Core cannot observe which build of the runner is asking, so advertising it would be core promising something it has no way to know — the runner satisfies that one from its own source.
  it('does not advertise the reaper that lives in the runner', () => {
    expect(PARK_PROTECTIONS as readonly string[]).not.toContain('worktree-reap-ledger');
  });
});
