import {
  RUNNER_RELEASE_STEPS,
  type RunnerReleasePublication,
  type RunnerReleaseStep,
  type RunnerReleaseTagState,
} from '../../db/schema-runner-release.js';

export const RUNNER_RELEASE_TAG_PREFIX = 'runner-v';

export const RUNNER_RELEASE_DEADLINE_MS = 90 * 60_000;

export const RUNNER_RELEASE_WORKFLOW_PATH = '.github/workflows/runner-release.yml';

/** The targets `runner-release.yml` builds, and therefore the assets a whole release carries. */
export const RUNNER_RELEASE_TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'] as const;

/** The prefix `install/fetch-release.ts` filters a release's assets by. */
export const RUNNER_ASSET_PREFIX = 'forge-runner-';

export const tagMessageForVersion = (version: string) => `forge-runner ${version}`;

export const RUNNER_CARGO_TOML_PATH = 'packages/runner/Cargo.toml';
export const RUNNER_CARGO_LOCK_PATH = 'packages/runner/Cargo.lock';

export const RUNNER_WORKSPACE_CRATES = ['forge-runner', 'forge-runner-core'] as const;

/** A step that could not pass, and the sentence an operator reads. */
export interface PreflightRefusal {
  step: RunnerReleaseStep;
  message: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** `runner-v` + the version, or the refusal naming what a version looks like. */
export function tagForVersion(version: string): { tag: string } | PreflightRefusal {
  const trimmed = version.trim();
  if (!VERSION_RE.test(trimmed)) {
    return {
      step: 'resolve_commit',
      message:
        `\`${version}\` is not a runner version. It is X.Y.Z in whole numbers, e.g. \`0.13.3\` ` +
        '— no `v`, no `runner-v` (Forge adds that), and no `-rc.N`: the install channel orders ' +
        'releases by dotted integers and reads a prerelease suffix as nothing, so it cannot tell ' +
        '`0.13.3-rc.1` from `0.13.3`.',
    };
  }
  return { tag: `${RUNNER_RELEASE_TAG_PREFIX}${trimmed}` };
}

/** Strip the tag prefix. The inverse of `tagForVersion`, and `fetch-release.ts`'s `tagToVersion`. */
export function versionForTag(tag: string): string {
  return tag.startsWith(RUNNER_RELEASE_TAG_PREFIX)
    ? tag.slice(RUNNER_RELEASE_TAG_PREFIX.length)
    : tag;
}

/** Whether a ref name is a runner release tag at all. */
export function isRunnerReleaseTag(ref: string): boolean {
  return ref.startsWith(RUNNER_RELEASE_TAG_PREFIX) && VERSION_RE.test(versionForTag(ref));
}

/** The asset name the workflow stages for one target. */
export function assetNameForTarget(target: string): string {
  return `${RUNNER_ASSET_PREFIX}${target}`;
}

export function workspacePackageVersion(cargoToml: string): string | null {
  let section = '';
  for (const raw of cargoToml.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const heading = /^\[+([^\]]+)\]+$/.exec(line);
    if (heading?.[1]) {
      section = heading[1].trim();
      continue;
    }
    if (section !== 'workspace.package') continue;
    const value = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (value?.[1]) return value[1];
  }
  return null;
}

/** Every `[[package]]` block's name and version, as the lockfile records them. */
export function lockedCrateVersions(cargoLock: string): Record<string, string> {
  const out: Record<string, string> = {};
  let name: string | null = null;
  let inPackage = false;
  for (const raw of cargoLock.split('\n')) {
    const line = raw.trim();
    if (line === '[[package]]') {
      inPackage = true;
      name = null;
      continue;
    }
    if (line.startsWith('[')) {
      inPackage = false;
      name = null;
      continue;
    }
    if (!inPackage) continue;
    const named = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (named?.[1]) {
      name = named[1];
      continue;
    }
    const versioned = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (versioned?.[1] && name) out[name] = versioned[1];
  }
  return out;
}

/** The `check_crate_version` step: the manifest at the commit must say this version. */
export function judgeCrateVersion(args: {
  version: string;
  commitSha: string;
  cargoToml: string;
}): PreflightRefusal | null {
  const declared = workspacePackageVersion(args.cargoToml);
  if (declared === null) {
    return {
      step: 'check_crate_version',
      message:
        `${RUNNER_CARGO_TOML_PATH} at ${args.commitSha} declares no \`[workspace.package]\` ` +
        'version, so nothing at that commit says which version the binary would report. Forge ' +
        'will not cut a tag over a manifest it cannot read.',
    };
  }
  if (declared !== args.version) {
    return {
      step: 'check_crate_version',
      message:
        `${RUNNER_CARGO_TOML_PATH} at ${args.commitSha} declares version \`${declared}\`, and the ` +
        `tag would say \`${args.version}\`. The binary self-reports its Cargo version, so a tag ` +
        'that disagrees leaves every runner downloading this release, restarting, and still ' +
        'reporting the old number — a perpetual update loop. Bump the manifest and its lockfile, ' +
        'land that commit, then cut the tag over it.',
    };
  }
  return null;
}

/** The `check_lockfile_version` step: the lockfile at the commit must agree with the manifest. */
export function judgeLockfileVersion(args: {
  version: string;
  commitSha: string;
  cargoLock: string;
}): PreflightRefusal | null {
  const locked = lockedCrateVersions(args.cargoLock);
  const wrong = RUNNER_WORKSPACE_CRATES.filter((crate) => locked[crate] !== args.version).map(
    (crate) => `${crate} is \`${locked[crate] ?? 'absent'}\``,
  );
  if (wrong.length === 0) return null;
  return {
    step: 'check_lockfile_version',
    message:
      `${RUNNER_CARGO_LOCK_PATH} at ${args.commitSha} does not record \`${args.version}\` for the ` +
      `workspace crates: ${wrong.join(', ')}. The release workflow builds \`--locked\`, so this ` +
      'commit cannot build under this tag, and a tag is immutable — runner-v0.6.2 burned a ' +
      'version number this way on 2026-06-25. Run `cargo metadata --locked` in packages/runner, ' +
      'land the regenerated lockfile, then cut the tag over that commit.',
  };
}

/** What GitHub holds for a tag, as the release read returns it. */
export interface ReleaseReading {
  htmlUrl: string | null;
  draft: boolean;
  prerelease: boolean;
  assetNames: string[];
}

export interface PublicationJudgement {
  publication: 'absent' | 'incomplete' | 'published';
  /** What is there and what is not. Always written, on every outcome. */
  detail: string;
}

export function judgePublication(
  release: ReleaseReading | null,
  targets: readonly string[] = RUNNER_RELEASE_TARGETS,
): PublicationJudgement {
  if (!release) {
    return { publication: 'absent', detail: 'GitHub holds no release for this tag.' };
  }
  const want = targets.map(assetNameForTarget);
  const missing = want.filter((name) => !release.assetNames.includes(name));
  const present = want.filter((name) => release.assetNames.includes(name));
  const faults: string[] = [];
  if (release.draft) faults.push('it is a draft, which the install channel skips');
  if (release.prerelease) faults.push('it is a prerelease, which the install channel skips');
  if (missing.length > 0) faults.push(`it is missing ${missing.join(', ')}`);
  if (faults.length === 0) {
    return {
      publication: 'published',
      detail: `GitHub holds a published release carrying ${want.join(', ')}.`,
    };
  }
  return {
    publication: 'incomplete',
    detail:
      `GitHub holds a release for this tag but ${faults.join('; ')}. ` +
      `Present: ${present.length > 0 ? present.join(', ') : 'none of the expected assets'}.`,
  };
}

/** The steps, exported so a caller can say how far a release got without importing the schema. */
export const RUNNER_RELEASE_STEP_ORDER: readonly RunnerReleaseStep[] = RUNNER_RELEASE_STEPS;

const IMMUTABLE =
  ' A tag is immutable, so Forge deletes none and re-cuts none: the way forward is the next version.';

export function repositoryTruth(args: {
  tag: string;
  commitSha: string | null;
  /** The commit the tag was OBSERVED at. NULL where nobody read it. */
  tagCommitSha?: string | null;
  tagState: RunnerReleaseTagState;
  publication: RunnerReleasePublication;
  publicationDetail: string | null;
}): string {
  const at = args.commitSha ? ` at ${args.commitSha}` : '';
  const atTag = args.tagCommitSha ? ` at ${args.tagCommitSha}` : '';
  if (args.tagState === 'unread') {
    return (
      `Nothing was written to the repository. Forge did not read whether the tag ` +
      `\`${args.tag}\` exists, so its existence is unread rather than ruled out.`
    );
  }
  if (args.tagState === 'absent') {
    return `Nothing was written to the repository: the tag \`${args.tag}\` does not exist.`;
  }
  if (args.tagState === 'unknown') {
    return (
      `Forge asked GitHub to create the tag \`${args.tag}\`${at} and never heard the answer, so ` +
      'the tag may or may not exist. Read the repository before cutting anything else.' +
      IMMUTABLE
    );
  }
  const exists = `The tag \`${args.tag}\` exists${atTag}`;
  switch (args.publication) {
    case 'published':
      return `${exists} and GitHub holds a published release for it.`;
    case 'absent':
      return `${exists} and GitHub holds no release for it — nothing is published.${IMMUTABLE}`;
    case 'incomplete':
      return `${exists}. ${args.publicationDetail ?? 'The release for it is not whole.'}${IMMUTABLE}`;
    case 'unknown':
      return (
        `${exists}, and Forge could not read what GitHub holds for it, so whether anything is ` +
        `published is unknown.${IMMUTABLE}`
      );
    default:
      return `${exists}; Forge has not read what GitHub holds for it.${IMMUTABLE}`;
  }
}
