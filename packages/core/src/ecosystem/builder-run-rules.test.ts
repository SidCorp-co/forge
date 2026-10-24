import { describe, expect, it } from 'vitest';
import { pushReading } from './builder-run-rules.js';
import { notInProjectRefusal } from './builder-supersede-rules.js';

// ISS-597 (REQ-73 BC-5): a push opens a builder run only on the branch the project builds from.

const projectId = '00000000-0000-4000-8000-000000000001';
const commit = 'd'.repeat(40);
const at = '2026-10-24T00:00:00.000Z';
const read = (branch: string | null, buildBranch: string | null, sha: string | null = commit) =>
  pushReading({ projectId, branch, buildBranch, commit: sha, at });

describe('pushReading', () => {
  it('opens a push run on the build branch, its trigger naming the ref', () => {
    expect(read('dev', 'dev')).toEqual({
      kind: 'open',
      trigger: {
        kind: 'push',
        sha: commit,
        head: { ref: 'refs/heads/dev', readAt: at, via: 'source-host' },
      },
    });
  });

  it("opens nothing for another branch, the host's default branch included", () => {
    for (const branch of ['main', 'feature/x', 'Dev']) {
      const reading = read(branch, 'dev');
      expect(reading.kind, branch).toBe('none');
    }
  });

  it('refuses by name a push naming no branch, or a project declaring no build branch', () => {
    const noBranch = read(null, 'dev');
    const noBuild = read('main', null);
    for (const reading of [noBranch, noBuild]) {
      expect(reading.kind).toBe('refused');
      if (reading.kind !== 'refused') continue;
      expect(reading.refusal.code).toBe('BUILDER_RUN_PUSH_UNATTRIBUTED');
      expect(reading.refusal.detail).toContain(projectId);
      expect(reading.refusal.detail).toContain('No builder run was opened');
    }
    expect(noBuild.kind === 'refused' && noBuild.refusal.detail).toContain(
      'declares no build branch',
    );
  });

  it('opens nothing for a deletion or a push naming no commit', () => {
    for (const sha of [null, '0'.repeat(40), 'abc'])
      expect(read('dev', 'dev', sha).kind).toBe('none');
  });
});

describe('notInProjectRefusal', () => {
  it('names the project and says nothing changed', () => {
    const refusal = notInProjectRefusal('run-1', 'forge');
    expect(refusal.code).toBe('BUILDER_RUN_NOT_IN_PROJECT');
    expect(refusal.detail).toContain('not a run of project forge');
    expect(refusal.detail).toContain('Nothing was changed');
  });
});
