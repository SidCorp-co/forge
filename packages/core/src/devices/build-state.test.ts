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

describe('compareRunnerBuild — a box that matches what landed', () => {
  it('is current when its version and its commit are both what landed', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('current');
    expect(r.detail).toContain('0.17.1');
  });
});

describe('compareRunnerBuild — a box that is behind', () => {
  it('is behind when its version is below the published release', () => {
    const r = compareRunnerBuild(
      { version: '0.17.0', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
    expect(r.detail).toBe('runner 0.17.0 is behind the published 0.17.1');
  });

  it('is behind on the commit alone, where the version agrees', () => {
    // This is the measured case: the box and the branch reported 0.17.0 while
    // seven commits separated them (ISS-1165).
    const r = compareRunnerBuild(
      { version: '0.17.0', commit: OLDER },
      { published: published('0.17.0', OLDER), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
    expect(r.detail).toContain('bd2e36d5ea');
    expect(r.detail).toContain('fbe6468ddf');
  });

  it('reads a version that is lower in its patch and not only in its minor', () => {
    const r = compareRunnerBuild(
      { version: '0.17.9', commit: HEAD },
      { published: published('0.17.10'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('behind');
  });
});

describe('compareRunnerBuild — what it will not call current', () => {
  it('is unknown, not current, where the box reported no commit', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: null },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('did not say which build');
  });

  it('is unknown, not current, where the default branch head could not be read', () => {
    const r = compareRunnerBuild(
      { version: '0.17.1', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: null },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('could not be read');
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
    expect(r.detail).toContain('no runner release is published');
  });

  it('is unknown, not behind, where the box is ahead of what is published', () => {
    const r = compareRunnerBuild(
      { version: '0.18.0', commit: HEAD },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('ahead of the published');
  });
});

describe('compareRunnerBuild — which comparison wins', () => {
  it('reports the version gap rather than the commit gap when both are open', () => {
    const r = compareRunnerBuild(
      { version: '0.16.0', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: HEAD },
    );
    expect(r.detail).toBe('runner 0.16.0 is behind the published 0.17.1');
  });

  it('does not let an unreadable branch head hide a version that is behind', () => {
    const r = compareRunnerBuild(
      { version: '0.16.0', commit: OLDER },
      { published: published('0.17.1'), mainRunnerHead: null },
    );
    expect(r.state).toBe('behind');
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
    published: { version: string; commit: string | null } | null,
    head: string | null,
  ) => {
    publishedRunnerBuild.mockResolvedValue(published);
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

  it('marks a box behind on the commit alone as outdated', async () => {
    const [row] = await annotate(
      [{ agentVersion: '0.17.0', agentCommit: OLDER }],
      { version: '0.17.0', commit: OLDER },
      HEAD,
    );
    expect(row?.agentBuildState).toBe('behind');
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
