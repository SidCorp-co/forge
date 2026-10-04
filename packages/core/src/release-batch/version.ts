// Three integers. A new release raises MINOR; PATCH is reserved for a re-cut of one that failed,
// and whether a version is eligible to be re-cut is the store's ruling, not this file's. Nine
// digits per component is the `int4` bound `db/column-checks.ts` mirrors inside Postgres.

interface PrereleaseTag {
  label: string;
  number: number;
}

export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  pre?: PrereleaseTag | undefined;
}

// cm:why `release.prerelease` of the project document: every cut is `<of>-<label>.<N>`.
export interface PrereleaseLine {
  of: ReleaseVersion;
  label: string;
}

const FIRST_RELEASE_VERSION: ReleaseVersion = { major: 0, minor: 1, patch: 0 };

const MAX_VERSION_COMPONENT = 999_999_999;

export function isStorableReleaseVersion(v: ReleaseVersion): boolean {
  return (
    v.major >= 0 &&
    v.minor >= 0 &&
    v.patch >= 0 &&
    v.major <= MAX_VERSION_COMPONENT &&
    v.minor <= MAX_VERSION_COMPONENT &&
    v.patch <= MAX_VERSION_COMPONENT &&
    (v.pre === undefined || (v.pre.number >= 1 && v.pre.number <= MAX_VERSION_COMPONENT))
  );
}

const VERSION_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([a-z][a-z0-9]{0,15})\.(\d{1,9}))?$/;

export const RELEASE_VERSION_SHAPE =
  'MAJOR.MINOR.PATCH, three dot-separated integers (e.g. 0.4.0), optionally followed by a prerelease -LABEL.N (e.g. 0.4.0-dev.2)';

export function formatReleaseVersion(v: ReleaseVersion): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${core}-${v.pre.label}.${v.pre.number}` : core;
}

export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return { major, minor, patch };
  return { major, minor, patch, pre: { label: m[4], number: Number(m[5]) } };
}

function releaseCore(v: ReleaseVersion): ReleaseVersion {
  return { major: v.major, minor: v.minor, patch: v.patch };
}

// cm:why semver precedence: a prerelease sorts below the release it previews (0.4.0-dev.9 < 0.4.0).
/** Digit by digit — never the lexical order of the two strings. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) + (b.pre ? 1 : 0);
  if (a.pre.label !== b.pre.label) return a.pre.label < b.pre.label ? -1 : 1;
  return a.pre.number - b.pre.number;
}

// cm:why after a prerelease line ends, the next plain release is the one that line previewed.
/** `highest` is the highest EVER cut, failed releases included: that is the whole of the burn. */
export function nextReleaseVersion(
  highest: ReleaseVersion | null,
  recutOf: ReleaseVersion | null,
  line: PrereleaseLine | null = null,
): ReleaseVersion {
  if (line) return nextOnLine(highest, line);
  if (recutOf) return { major: recutOf.major, minor: recutOf.minor, patch: recutOf.patch + 1 };
  if (!highest) return FIRST_RELEASE_VERSION;
  if (highest.pre) return releaseCore(highest);
  return { major: highest.major, minor: highest.minor + 1, patch: 0 };
}

// cm:why N continues only from a highest on this same line; landing above it is the store's ruling.
function nextOnLine(highest: ReleaseVersion | null, line: PrereleaseLine): ReleaseVersion {
  const pre = highest?.pre;
  const onLine =
    highest !== null &&
    pre !== undefined &&
    pre.label === line.label &&
    compareReleaseVersions(releaseCore(highest), releaseCore(line.of)) === 0;
  return {
    ...releaseCore(line.of),
    pre: { label: line.label, number: onLine ? pre.number + 1 : 1 },
  };
}
