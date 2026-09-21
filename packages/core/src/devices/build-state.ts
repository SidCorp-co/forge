import { cmpVersion } from '../install/fetch-release.js';
import { mainRunnerHead } from '../install/main-runner-head.js';
import { getPublishedRunnerBuild } from '../install/routes.js';

/**
 * Whether a box is running the runner `main` holds. Two comparisons: the version
 * says whether it is behind what was PUBLISHED, the commit whether it is behind what
 * LANDED — and only the second catches a release that was never cut (ISS-1165).
 * Three answers rather than two, because "we cannot tell" is not "it is fine".
 */
export type RunnerBuildState = 'current' | 'behind' | 'unknown';

export interface RunnerBuildComparison {
  state: RunnerBuildState;
  /** One sentence naming what was compared and what it found. */
  detail: string;
}

export interface DeviceBuild {
  version: string | null;
  commit: string | null;
}

export interface ReferenceBuild {
  /** The newest published release, or null where nothing is published. */
  published: { version: string; commit: string | null } | null;
  /** The newest commit under `packages/runner` on the default branch, or null. */
  mainRunnerHead: string | null;
}

export function compareRunnerBuild(
  device: DeviceBuild,
  reference: ReferenceBuild,
): RunnerBuildComparison {
  const { published, mainRunnerHead } = reference;

  if (device.version === null) {
    return { state: 'unknown', detail: 'this box has not reported a runner version' };
  }
  if (published === null) {
    return { state: 'unknown', detail: 'no runner release is published to compare against' };
  }
  if (cmpVersion(device.version, published.version) < 0) {
    return {
      state: 'behind',
      detail: `runner ${device.version} is behind the published ${published.version}`,
    };
  }
  // Ahead of what is published: a branch build, or a withdrawn release. Neither
  // behind nor anything this comparison can call current.
  if (cmpVersion(device.version, published.version) > 0) {
    return {
      state: 'unknown',
      detail: `runner ${device.version} is ahead of the published ${published.version}`,
    };
  }
  if (device.commit === null) {
    return {
      state: 'unknown',
      detail: `runner ${device.version} matches the published release, but this box did not say which build it is running`,
    };
  }
  if (mainRunnerHead === null) {
    return {
      state: 'unknown',
      detail: `runner ${device.version} matches the published release, but the runner head on the default branch could not be read`,
    };
  }
  if (device.commit !== mainRunnerHead) {
    return {
      state: 'behind',
      detail: `runner ${device.version} is built from ${short(device.commit)}, and the default branch holds ${short(mainRunnerHead)}`,
    };
  }
  return {
    state: 'current',
    detail: `runner ${device.version} (${short(device.commit)}) is what the default branch holds`,
  };
}

function short(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

interface DeviceRowBuild {
  agentVersion: string | null;
  agentCommit: string | null;
}

/**
 * Annotate each row with the build it is running and what that was compared against.
 * One read of the release and the branch head serves the whole list.
 */
export async function annotateDeviceBuilds<T extends DeviceRowBuild>(rows: T[]) {
  const published = await getPublishedRunnerBuild();
  const head = mainRunnerHead();
  return rows.map((r) => {
    const build = compareRunnerBuild(
      { version: r.agentVersion, commit: r.agentCommit },
      { published, mainRunnerHead: head },
    );
    return {
      ...r,
      latestAgentVersion: published?.version ?? null,
      latestAgentCommit: published?.commit ?? null,
      mainRunnerHead: head,
      agentBuildState: build.state,
      agentBuildDetail: build.detail,
      agentOutdated: build.state === 'behind',
    };
  });
}
