// Three integers. A new release raises MINOR; PATCH is reserved for a re-cut of one that failed,
// and whether a version is eligible to be re-cut is the store's ruling, not this file's. Nine
// digits per component is the `int4` bound `db/column-checks.ts` mirrors inside Postgres.

export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

export const FIRST_RELEASE_VERSION: ReleaseVersion = { major: 0, minor: 1, patch: 0 };

export const MAX_VERSION_COMPONENT = 999_999_999;

export function isStorableReleaseVersion(v: ReleaseVersion): boolean {
  return (
    v.major >= 0 &&
    v.minor >= 0 &&
    v.patch >= 0 &&
    v.major <= MAX_VERSION_COMPONENT &&
    v.minor <= MAX_VERSION_COMPONENT &&
    v.patch <= MAX_VERSION_COMPONENT
  );
}

const VERSION_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export const RELEASE_VERSION_SHAPE = 'MAJOR.MINOR.PATCH, three dot-separated integers (e.g. 0.4.0)';

export function formatReleaseVersion(v: ReleaseVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { major, minor, patch };
}

/** Digit by digit — never the lexical order of the two strings. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `highest` is the highest EVER cut, failed releases included: that is the whole of the burn. */
export function nextReleaseVersion(
  highest: ReleaseVersion | null,
  recutOf: ReleaseVersion | null,
): ReleaseVersion {
  if (recutOf) return { major: recutOf.major, minor: recutOf.minor, patch: recutOf.patch + 1 };
  if (!highest) return FIRST_RELEASE_VERSION;
  return { major: highest.major, minor: highest.minor + 1, patch: 0 };
}
