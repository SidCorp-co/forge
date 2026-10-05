import type { RunnerBuildComparison, RunnerBuildState } from '../runners/index.js';
import { devicesPorts } from './ports.js';
import { getPublishedRunnerBuild } from './published-build.js';

export type { RunnerBuildComparison };

interface DeviceBuild {
  version: string | null;
  commit: string | null;
}

interface ReferenceBuild {
  /** The newest published release, or null where nothing is published. */
  published: { version: string; commit: string | null } | null;
  /** The newest commit under the runner package on the default branch, or null. */
  mainRunnerHead: string | null;
}

function short(sha: string): string {
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

function judgeRelease(reference: ReferenceBuild): { state: RunnerBuildState; detail: string } {
  const { published, mainRunnerHead: head } = reference;
  if (published === null) {
    return { state: 'unknown', detail: 'no runner release is published' };
  }
  if (published.commit === null) {
    return { state: 'unknown', detail: `release ${published.version} records no commit` };
  }
  if (head === null) {
    return { state: 'unknown', detail: 'the runner on the default branch could not be read' };
  }
  if (published.commit !== head) {
    return {
      state: 'behind',
      detail: `release ${published.version} carries ${short(published.commit)}, and the default branch holds ${short(head)} — no release carries what landed`,
    };
  }
  return { state: 'current', detail: `release ${published.version} is what landed` };
}

/** This box against the published release. */
function judgeBox(
  device: DeviceBuild,
  published: ReferenceBuild['published'],
): { state: RunnerBuildState; detail: string } {
  if (device.version === null) {
    return { state: 'unknown', detail: 'this box has not reported a runner version' };
  }
  if (published === null) {
    return { state: 'unknown', detail: 'no runner release is published to compare against' };
  }
  const order = devicesPorts().cmpVersion(device.version, published.version);
  if (order < 0) {
    return {
      state: 'behind',
      detail: `runner ${device.version} is behind the published ${published.version}`,
    };
  }
  if (order > 0) {
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
  if (published.commit === null) {
    return {
      state: 'unknown',
      detail: `runner ${device.version} matches the published release, which records no commit to compare against`,
    };
  }
  if (device.commit !== published.commit) {
    return {
      state: 'behind',
      detail: `runner ${device.version} is built from ${short(device.commit)}, and the published release carries ${short(published.commit)} — this box is not running a published build`,
    };
  }
  return { state: 'current', detail: `runner ${device.version} (${short(device.commit)})` };
}

function compareRunnerBuild(device: DeviceBuild, reference: ReferenceBuild): RunnerBuildComparison {
  const box = judgeBox(device, reference.published);
  const release = judgeRelease(reference);
  const outdated = box.state === 'behind' || release.state === 'behind';
  // The box's own reading leads, because that is what an operator acts on; the
  // release's follows only where it changes the verdict or the box's is clean.
  const detail =
    box.state === 'behind'
      ? box.detail
      : release.state === 'behind'
        ? `${box.detail}, but ${release.detail}`
        : box.detail;
  return { state: box.state, releaseState: release.state, outdated, detail };
}

interface DeviceRowBuild {
  agentVersion: string | null;
  agentCommit: string | null;
}

/**
 * Annotate each row with the build it is running and what that was compared
 * against. One read of the release and the branch head serves the whole list.
 */
export async function annotateDeviceBuilds<T extends DeviceRowBuild>(rows: T[]) {
  const published = await getPublishedRunnerBuild();
  const head = devicesPorts().mainRunnerHead();
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
      runnerReleaseState: build.releaseState,
      agentBuildDetail: build.detail,
      agentOutdated: build.outdated,
    };
  });
}
