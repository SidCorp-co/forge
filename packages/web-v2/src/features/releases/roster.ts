/**
 * The release roster as this app reads it, and the one check that a response
 * still has that shape.
 *
 * Core renamed the roster's `channel` to `channels` in ISS-1046. The web side
 * kept declaring `channel` and `apiClient` casts rather than checks, so the
 * key read as an absent value and the release gate panel told every operator
 * that nobody deploys their project. A key the server stops sending is refused
 * here instead, by name, where the drift is.
 */

export interface ReleaseRosterEntry {
  id: string;
  displayId: string;
  title: string;
  mergedAt: string | null;
  waitingDays: number | null;
  claimedByRunId: string | null;
}

/**
 * What the project's release surface reads. `gateStatus: null` = no gate.
 *
 * This is the projection this app depends on, not a mirror of the response:
 * core answers keys no screen here reads, and `parseReleaseRoster` checks
 * exactly what is declared below.
 */
export interface ReleaseRoster {
  gateStatus: string | null;
  /** Every live deploy binding's provider. Empty = nobody deploys this. */
  channels: string[];
  releaseRunnerLabel: string | null;
  baseBranch: string | null;
  nextCutAt: string | null;
  issues: ReleaseRosterEntry[];
}

export class RosterShapeError extends Error {
  readonly endpoint: string;
  readonly at: string;

  constructor(endpoint: string, at: string, expected: string, got: unknown) {
    super(
      `${endpoint} answered a release roster this app cannot read: ${at} should be ${expected}, and the response carries ${describe(got)}. The server's roster shape has moved.`,
    );
    this.name = "RosterShapeError";
    this.endpoint = endpoint;
    this.at = at;
  }
}

function describe(got: unknown): string {
  if (got === undefined) return "no such key";
  if (got === null) return "null";
  if (Array.isArray(got)) return "an array";
  return `a ${typeof got}`;
}

/** Read a key so that an absent one is `undefined` and never reads as null. */
function keyAt(o: Record<string, unknown>, key: string): unknown {
  return key in o ? o[key] : undefined;
}

function objectAt(raw: unknown, endpoint: string, where: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RosterShapeError(endpoint, where, "an object", raw);
  }
  return raw as Record<string, unknown>;
}

function stringAt(o: Record<string, unknown>, key: string, endpoint: string, where: string): string {
  const v = keyAt(o, key);
  if (typeof v !== "string") throw new RosterShapeError(endpoint, where, "a string", v);
  return v;
}

function nullableStringAt(
  o: Record<string, unknown>,
  key: string,
  endpoint: string,
  where: string,
): string | null {
  const v = keyAt(o, key);
  if (v === null) return null;
  if (typeof v !== "string") throw new RosterShapeError(endpoint, where, "a string or null", v);
  return v;
}

function nullableNumberAt(
  o: Record<string, unknown>,
  key: string,
  endpoint: string,
  where: string,
): number | null {
  const v = keyAt(o, key);
  if (v === null) return null;
  if (typeof v !== "number") throw new RosterShapeError(endpoint, where, "a number or null", v);
  return v;
}

function stringsAt(
  o: Record<string, unknown>,
  key: string,
  endpoint: string,
  where: string,
): string[] {
  const v = keyAt(o, key);
  if (!Array.isArray(v)) throw new RosterShapeError(endpoint, where, "an array of strings", v);
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new RosterShapeError(endpoint, `${where}[${i}]`, "a string", item);
    }
    return item;
  });
}

function entryAt(raw: unknown, endpoint: string, where: string): ReleaseRosterEntry {
  const o = objectAt(raw, endpoint, where);
  return {
    id: stringAt(o, "id", endpoint, `${where}.id`),
    displayId: stringAt(o, "displayId", endpoint, `${where}.displayId`),
    title: stringAt(o, "title", endpoint, `${where}.title`),
    mergedAt: nullableStringAt(o, "mergedAt", endpoint, `${where}.mergedAt`),
    waitingDays: nullableNumberAt(o, "waitingDays", endpoint, `${where}.waitingDays`),
    claimedByRunId: nullableStringAt(o, "claimedByRunId", endpoint, `${where}.claimedByRunId`),
  };
}

/**
 * Check a roster response against the shape above, or refuse it naming the
 * endpoint, the key and what was expected there. Every declared key is read,
 * so the next server-side rename breaks here rather than on a screen.
 */
export function parseReleaseRoster(raw: unknown, endpoint: string): ReleaseRoster {
  const o = objectAt(raw, endpoint, "the response");
  const issues = keyAt(o, "issues");
  if (!Array.isArray(issues)) {
    throw new RosterShapeError(endpoint, "issues", "an array", issues);
  }
  return {
    gateStatus: nullableStringAt(o, "gateStatus", endpoint, "gateStatus"),
    channels: stringsAt(o, "channels", endpoint, "channels"),
    releaseRunnerLabel: nullableStringAt(o, "releaseRunnerLabel", endpoint, "releaseRunnerLabel"),
    baseBranch: nullableStringAt(o, "baseBranch", endpoint, "baseBranch"),
    nextCutAt: nullableStringAt(o, "nextCutAt", endpoint, "nextCutAt"),
    issues: issues.map((entry, i) => entryAt(entry, endpoint, `issues[${i}]`)),
  };
}
