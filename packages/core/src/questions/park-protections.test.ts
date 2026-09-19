import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARK_PROTECTIONS } from './protections.js';

const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

const BEHIND: Record<(typeof PARK_PROTECTIONS)[number], { file: string; proof: RegExp }> = {
  'park-exempt-residency': {
    file: 'jobs/park-deadline.ts',
    proof: /NOT_A_PROCESSLESS_PARK = sql`NOT \$\{parkedOnAHuman/,
  },
  'park-exempt-oneshot': {
    file: 'pipeline/sweeper.ts',
    proof: /OR \$\{parkedOnAHuman\(sql`s\.id`\)\}/,
  },
  'answer-resume-park': {
    file: 'pipeline/answer-resume.ts',
    proof: /aBoxWillReadThisAnswer/,
  },
};

describe('the park protections core advertises', () => {
  it.each(PARK_PROTECTIONS)('has the code behind %s in this build', (name) => {
    const behind = BEHIND[name];
    expect(behind, `no proof registered for ${name}`).toBeDefined();
    expect(src(behind.file)).toMatch(behind.proof);
  });

  it('advertises exactly the protections it can prove', () => {
    expect(Object.keys(BEHIND).sort()).toEqual([...PARK_PROTECTIONS].sort());
  });

  it('does not advertise the reaper that lives in the runner', () => {
    expect(PARK_PROTECTIONS as readonly string[]).not.toContain('worktree-reap-ledger');
  });
});
