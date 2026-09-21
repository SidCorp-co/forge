import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishedRunnerBuild = vi.fn(
  async (): Promise<{ version: string; commit: string | null } | null> => null,
);
vi.mock('../install/routes.js', () => ({
  getPublishedRunnerBuild: () => publishedRunnerBuild(),
}));
const runnerHead = vi.fn((): string | null => null);
vi.mock('../install/main-runner-head.js', () => ({
  mainRunnerHead: () => runnerHead(),
}));

const { annotateDeviceBuilds, compareRunnerBuild } = await import('./build-state.js');

const HEAD = 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8';
const OLDER = 'bd2e36d5ea1b2c3d4e5f60718293a4b5c6d7e8f9';

const published = (version: string, commit: string | null = HEAD) => ({ version, commit });

describe('compareRunnerBuild — a box running what landed', () => {
  it('is current when it matches the published release and that release is what landed', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r).toMatchObject({ state: 'current', releaseState: 'current', outdated: false });
    expect(r.detail).toBe('runner 0.17.1 (fbe6468ddf)');
  });
});

describe('compareRunnerBuild — the box against the published release', () => {
  it('is behind when its version is below the published release', () => {
    const r = compareRunnerBuild(
      { version: '0.17.0', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
    expect(r.outdated).toBe(true);
    expect(r.detail).toBe('runner 0.17.0 is behind the published 0.17.1');
  });

  it('is behind on the commit alone, where the version agrees', () => {
    // A hand-built binary carrying the released number: the case a version
    // comparison cannot see, and the one this box was in (ISS-1165).
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
    expect(r.detail).toContain('is not running a published build');
  });

  it('reads a version lower in its patch and not only in its minor', () => {
    const r = compareRunnerBuild(
      { version: '0.17.9', commit: HEAD },
      { published: published('0.17.10'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
  });
});

describe('compareRunnerBuild — the published release against what landed', () => {
  // The failed-trigger detector: nothing was published for the code that landed,
  // so every box is behind however faithfully it runs the last release.
  it('marks a box outdated when no release carries the runner on the branch', () => {
    const r = compareRunnerBuild(
      { version: '0.17.0', commit: OLDER },
      { published: published('0.17.0', OLDER), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('current');
    expect(r.releaseState).toBe('behind');
    expect(r.outdated).toBe(true);
    expect(r.detail).toContain('no release carries what landed');
  });

  it('names the box first and the release second when both are readable', () => {
    const r = compareRunnerBuild(
      { version: '0.17.0', commit: OLDER },
      { published: published('0.17.0', OLDER), mainRunnerHead: HEAD },
    );
    expect(r.detail.startsWith('runner 0.17.0 (bd2e36d5ea)')).toBe(true);
  });

  it('reports the box behind rather than the release when both are', () => {
    const r = compareRunnerBuild(
      { version: '0.16.0', commit: OLDER },
      { published: published('0.17.0', OLDER), mainRunnerHead: HEAD },
    );
    expect(r.detail).toBe('runner 0.16.0 is behind the published 0.17.0');
  });
});

describe('compareRunnerBuild — what it will not call current', () => {
  it('is unknown where the box reported no commit', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: null },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('did not say which build');
  });

  it('is unknown where the box has reported no version at all', () => {
    const r = compareRunnerBuild(
      { version: null, commit: null },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('has not reported a runner version');
  });

  it('is unknown where nothing is published to compare against', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: null, mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.releaseState).toBe('unknown');
  });

  it('is unknown, not behind, where the box is ahead of what is published', () => {
    const r = compareRunnerBuild(
      { version: '0.18.0', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('ahead of the published');
  });

  it('is unknown where the published release records no commit to compare against', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: published('0.17.1', null), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.releaseState).toBe('unknown');
  });
});

describe("compareRunnerBuild — core's own blind spot is not the box's fault", () => {
  // A GitHub outage must not turn every row red: the box is still verified against
  // the newest thing core can see.
  it('leaves a box that matches the published release current when the branch cannot be read', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: null },
    );
    expect(r.state).toBe('current');
    expect(r.releaseState).toBe('unknown');
    expect(r.outdated).toBe(false);
  });

  it('does not let an unreadable branch hide a version that is behind', () => {
    const r = compareRunnerBuild(
      { version: '0.16.0', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: null },
    );
    expect(r.state).toBe('behind');
    expect(r.outdated).toBe(true);
  });

  it('does not let a missing box commit hide a version that is behind', () => {
    const r = compareRunnerBuild(
      { version: '0.16.0', commit: null },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
  });
});

describe('annotateDeviceBuilds — what a device row carries', () => {
  beforeEach(() => {
    publishedRunnerBuild.mockReset();
    runnerHead.mockReset();
  });

  const annotate = async (
    rows: Array<{ agentVersion: string | null; agentCommit: string | null }>,
    release: { version: string; commit: string | null } | null,
    head: string | null,
  ) => {
    publishedRunnerBuild.mockResolvedValue(release);
    runnerHead.mockReturnValue(head);
    return annotateDeviceBuilds(rows);
  };

  it('marks a box behind the published version as outdated', async () => {
    const [row] = await annotate(
      [{ agentVersion: '0.17.0', agentCommit: OLDER }],
      { version: '0.17.1', commit: HEAD },
      HEAD,
    );
    expect(row?.agentBuildState).toBe('behind');
    expect(row?.agentOutdated).toBe(true);
    expect(row?.latestAgentVersion).toBe('0.17.1');
  });

  it('marks a box outdated when the release itself is behind the branch', async () => {
    const [row] = await annotate(
      [{ agentVersion: '0.17.0', agentCommit: OLDER }],
      { version: '0.17.0', commit: OLDER },
      HEAD,
    );
    expect(row?.runnerReleaseState).toBe('behind');
    expect(row?.agentOutdated).toBe(true);
    expect(row?.mainRunnerHead).toBe(HEAD);
  });

  it('marks a box carrying what landed as current and not outdated', async () => {
    const [row] = await annotate(
      [{ agentVersion: '0.17.1', agentCommit: HEAD }],
      { version: '0.17.1', commit: HEAD },
      HEAD,
    );
    expect(row?.agentBuildState).toBe('current');
    expect(row?.agentOutdated).toBe(false);
    expect(row?.latestAgentCommit).toBe(HEAD);
  });

  it('marks a box that sent no commit unknown rather than outdated', async () => {
    const [row] = await annotate(
      [{ agentVersion: '0.17.1', agentCommit: null }],
      { version: '0.17.1', commit: HEAD },
      HEAD,
    );
    expect(row?.agentBuildState).toBe('unknown');
    expect(row?.agentOutdated).toBe(false);
    expect(row?.agentBuildDetail).toContain('did not say which build');
  });

  it('reads the release and the branch head once for the whole list', async () => {
    const rows = await annotate(
      [
        { agentVersion: '0.17.1', agentCommit: HEAD },
        { agentVersion: '0.17.0', agentCommit: OLDER },
      ],
      { version: '0.17.1', commit: HEAD },
      HEAD,
    );
    expect(rows.map((r) => r.agentBuildState)).toEqual(['current', 'behind']);
    expect(publishedRunnerBuild).toHaveBeenCalledTimes(1);
    expect(runnerHead).toHaveBeenCalledTimes(1);
  });

  it('keeps every field the row already carried', async () => {
    const [row] = await annotate([{ agentVersion: '0.17.1', agentCommit: HEAD }], null, null);
    expect(row?.agentVersion).toBe('0.17.1');
    expect(row?.agentCommit).toBe(HEAD);
  });
});
