// What a release version IS, with no database in the file. The store beside this one holds the
// reading and the writing; these are the rules, so a reader can check them against the owner's
// three answers without a Postgres in the room.
//
// The three answers, ISS-1120 comment 43e51ce1:
//   1. The MINOR digit increments, once per release. PATCH is reserved for a re-cut after a
//      failed release. Semver's usual meaning does not transfer — Forge's API has no downstream
//      consumers, so "breaking change" is not the axis; "which batch shipped" is.
//   2. A failed release BURNS its number. That rule is not in this file at all, and that is the
//      point: `nextReleaseVersion` is handed the highest version ever CUT, not the highest that
//      shipped, so a burned number is one the caller can never offer back.
//   3. The number lives on the release row, which `version-store.ts` owns.
//
// Nothing here moves the MAJOR digit. The owner named minor and patch and named no axis for
// major, so a project that has cut nothing starts at 0.1.0 and major only ever moves by hand.

/** Three integers. Nothing here is a range, a pre-release tag or a build identifier. */
export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
}

/** The floor for a project that has never cut a release. */
export const FIRST_RELEASE_VERSION: ReleaseVersion = { major: 0, minor: 1, patch: 0 };

/**
 * The largest value any component may hold: nine digits, which is the bound the shape below and
 * the column's CHECK both enforce, and the largest value Postgres holds in the `int4` the store
 * orders by. A successor past it is refused by name in `version-store.ts` rather than written and
 * bounced off the constraint — the constraint would name itself, which tells the caller what broke
 * but not which rule they hit.
 */
export const MAX_VERSION_COMPONENT = 999_999_999;

/** Whether every component of this version is one the shape and the column both admit. */
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

/**
 * The one shape a release version may take, kept beside `releaseVersionText` in
 * `db/column-checks.ts` — that predicate is the same rule written where Postgres can enforce it,
 * nine digits per component and all. The bound is not decoration: the store orders releases by
 * casting the column to an `int[]`, and a tenth digit is a value both sides have to refuse at the
 * write or throw on at every later read.
 */
const VERSION_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

/** The shape a caller who got it wrong is told to send, carried in the refusals themselves. */
export const RELEASE_VERSION_SHAPE = 'MAJOR.MINOR.PATCH, three dot-separated integers (e.g. 0.4.0)';

export function formatReleaseVersion(v: ReleaseVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** `null` for anything that is not three dot-separated integers. Never a guess at the intent. */
export function parseReleaseVersion(text: string): ReleaseVersion | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  // Nine digits at most, so each of these is an exact integer and fits an `int4` column.
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { major, minor, patch };
}

/** Negative, zero or positive, digit by digit — never the lexical order of the two strings. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The next version to cut.
 *
 * `highest` is the highest version EVER cut on this project — including the ones releases failed
 * with. That is the whole of the burn: a failed 0.5.0 stays the highest until something above it
 * is cut, so the next new release is 0.6.0 and nothing can ever wear 0.5.0 again.
 *
 * `recutOf` is the version of a failed release being cut again, and it raises the patch digit
 * instead. Whether a given version is eligible to be re-cut is not a question this file can
 * answer — it needs the row's status and its ship stamp — so the store rules on that before
 * calling, and this function assumes the ruling has been made.
 */
export function nextReleaseVersion(
  highest: ReleaseVersion | null,
  recutOf: ReleaseVersion | null,
): ReleaseVersion {
  if (recutOf) return { major: recutOf.major, minor: recutOf.minor, patch: recutOf.patch + 1 };
  if (!highest) return FIRST_RELEASE_VERSION;
  return { major: highest.major, minor: highest.minor + 1, patch: 0 };
}
