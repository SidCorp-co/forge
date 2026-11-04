import { describe, expect, it } from 'vitest';
import type { ReleasePath } from '../project-config/index.js';
import type { ReleasePlan } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';

// ISS-955 (FB-492): a release run is told the commit each roster issue landed at, and that the head it
// cuts must hold every one, so it no longer tags a commit older than an issue it then closes.

const MARK = 'a'.repeat(40);
const path = { defaultBranch: 'dev', production: null, crossing: null } as unknown as ReleasePath;
const plan: ReleasePlan = { channels: [], releaseRunnerLabel: null, procedure: null };

const prompt = (marks: (string | null)[]) =>
  buildReleaseBatchPrompt({
    runId: 'run-1',
    projectId: 'project-1',
    defaultBranch: 'dev',
    path,
    plan,
    releaseRunnerPreferenceMet: true,
    issues: marks.map((markedCommit, n) => ({
      id: `issue-${n}`,
      displayId: `ISS-${n + 1}`,
      title: `Issue ${n + 1}`,
      markedCommit,
    })),
  });

describe('the release prompt names each roster issue’s marked commit (ISS-955)', () => {
  it('puts the marked commit on the issue’s roster line', () => {
    const text = prompt([MARK]);
    const line = text.split('\n').find((l) => l.startsWith('- ISS-1'));
    expect(line).toContain(`marked at \`${MARK}\``);
  });

  it('tells the run to cut from a head that holds every marked commit, or abort naming the issue', () => {
    const text = prompt([MARK, null]);
    expect(text).toContain('git merge-base --is-ancestor <commit> <head>');
    expect(text).toContain('abort naming that issue');
    expect(text.split('\n').find((l) => l.startsWith('- ISS-2'))).toContain('no commit marked');
  });

  it('says nothing of ancestry where no roster issue has a marked commit', () => {
    const text = prompt([null, null]);
    expect(text).not.toContain('merge-base');
  });
});
