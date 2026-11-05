import type { ReleaseSummary } from "./types";

// The Releases list in three groups (ISS-1001, the approved report shape): what waits on the reader,
// what is going to production, and what is in production, the last few shown and the rest folded.
// A release a later one already carries folds into one line under that release, never a row of its
// own: a landing on a branch production does not deploy from (adminhub-fe: 0.1.0 to 0.52.0 on stg,
// all in the draft 0.56.0), and an attempt that ended unshipped, whose roster went back to the gate.
// Core answers the releases newest first, and that order is kept.

/** A release on the list, and the earlier ones it carries, newest first. */
export interface ReleaseLine {
  release: ReleaseSummary;
  carries: ReleaseSummary[];
}

export interface ReleaseList {
  you: ReleaseLine[];
  going: ReleaseLine[];
  /** In production, newest first: the last `PRODUCTION_SHOWN`. */
  production: ReleaseLine[];
  /** In production before those, folded behind one row. */
  older: ReleaseLine[];
}

/** How many releases in production the list shows before folding the rest. */
export const PRODUCTION_SHOWN = 3;

const ENDED_UNSHIPPED: ReadonlySet<ReleaseSummary["state"]> = new Set(["failed", "aborted"]);

/** A release that a later release carries: a landing off production's branch, or an attempt that ended. */
const carriable = (r: ReleaseSummary) => r.state === "landed" || ENDED_UNSHIPPED.has(r.state);

/**
 * The release that carries `r`, among those newer than it: the newest still on its way (a draft, one
 * cut and waiting, one going out), else the newest in production. Null where none is newer.
 */
function carrierOf(newer: readonly ReleaseSummary[]): ReleaseSummary | null {
  const holders = newer.filter((n) => !carriable(n));
  return holders.find((n) => n.state !== "shipped") ?? holders.find((n) => n.state === "shipped") ?? null;
}

export function releaseListOf(releases: readonly ReleaseSummary[], shown = PRODUCTION_SHOWN): ReleaseList {
  const carried = new Map<string, ReleaseSummary[]>();
  const own: ReleaseSummary[] = [];
  releases.forEach((r, i) => {
    const carrier = carriable(r) ? carrierOf(releases.slice(0, i)) : null;
    if (carrier) carried.set(carrier.version, [...(carried.get(carrier.version) ?? []), r]);
    else own.push(r);
  });
  const line = (r: ReleaseSummary): ReleaseLine => ({ release: r, carries: carried.get(r.version) ?? [] });
  const live = own.filter((r) => r.state !== "shipped");
  const shipped = own.filter((r) => r.state === "shipped").map(line);
  return {
    you: live.filter((r) => r.waitingOn.kind === "you").map(line),
    going: live.filter((r) => r.waitingOn.kind !== "you").map(line),
    production: shipped.slice(0, shown),
    older: shipped.slice(shown),
  };
}

/** Every release a list line stands for: its own and those it carries, as the list reports them shown. */
export const versionsOf = (lines: readonly ReleaseLine[]): string[] => lines.flatMap((l) => [l.release.version, ...l.carries.map((c) => c.version)]);
