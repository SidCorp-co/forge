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

class RosterShapeError extends Error {
  constructor(endpoint: string, at: string, expected: string, got: unknown) {
    super(
      `${endpoint} answered a release roster this app cannot read: ${at} should be ${expected}, and the response carries ${describe(got)}. The server's roster shape has moved.`,
    );
    this.name = "RosterShapeError";
  }
}

function describe(got: unknown): string {
  if (got === undefined) return "no such key";
  if (got === null) return "null";
  if (Array.isArray(got)) return "an array";
  return `a ${typeof got}`;
}

type Obj = Record<string, unknown>;
type Expected = "a string" | "a string or null" | "a number or null";

const HOLDS: Record<Expected, (v: unknown) => boolean> = {
  "a string": (v) => typeof v === "string",
  "a string or null": (v) => v === null || typeof v === "string",
  "a number or null": (v) => v === null || typeof v === "number",
};

/**
 * Check a roster response against the shape above, or refuse it naming the
 * endpoint, the key and what was expected there. Every declared key is read,
 * so the next server-side rename breaks here rather than on a screen.
 */
export function parseReleaseRoster(raw: unknown, endpoint: string): ReleaseRoster {
  const fail = (at: string, expected: string, got: unknown): never => {
    throw new RosterShapeError(endpoint, at, expected, got);
  };
  const object = (v: unknown, at: string): Obj =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : fail(at, "an object", v);
  // `key in o`, so an absent key reads as `undefined` and never as null.
  const valueAt = (o: Obj, key: string) => (key in o ? o[key] : undefined);
  const array = (v: unknown, at: string, expected: string): unknown[] =>
    Array.isArray(v) ? v : fail(at, expected, v);
  function field<T>(o: Obj, key: string, expected: Expected, at = key): T {
    const v = valueAt(o, key);
    return (HOLDS[expected](v) ? v : fail(at, expected, v)) as T;
  }

  const o = object(raw, "the response");
  const issues = array(valueAt(o, "issues"), "issues", "an array");
  return {
    gateStatus: field(o, "gateStatus", "a string or null"),
    channels: array(valueAt(o, "channels"), "channels", "an array of strings").map((item, i) =>
      typeof item === "string" ? item : fail(`channels[${i}]`, "a string", item),
    ),
    releaseRunnerLabel: field(o, "releaseRunnerLabel", "a string or null"),
    baseBranch: field(o, "baseBranch", "a string or null"),
    nextCutAt: field(o, "nextCutAt", "a string or null"),
    issues: issues.map((entry, i) => {
      const at = `issues[${i}]`;
      const e = object(entry, at);
      return {
        id: field(e, "id", "a string", `${at}.id`),
        displayId: field(e, "displayId", "a string", `${at}.displayId`),
        title: field(e, "title", "a string", `${at}.title`),
        mergedAt: field(e, "mergedAt", "a string or null", `${at}.mergedAt`),
        waitingDays: field(e, "waitingDays", "a number or null", `${at}.waitingDays`),
        claimedByRunId: field(e, "claimedByRunId", "a string or null", `${at}.claimedByRunId`),
      };
    }),
  };
}
