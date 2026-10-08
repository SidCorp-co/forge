// Which version an attempt wears, and which release an attempt belongs to (ADR 0011). Pure: the
// runs come in already read, so the cut, the blocker check, the draft and the read model all ask
// the same rule and none of them keeps its own copy.
//
// A RELEASE is one roster carried through its attempts. Attempt N+1 re-cuts attempt N when its
// roster is the same SET of issues and attempt N ended without shipping; anything added or dropped
// makes it a new release, with a new version. A re-cut wears the version its predecessor wore unless
// something outside Forge already carries that version, and an ended attempt that never said what
// left its box makes the rule undecidable, which is refused by name rather than guessed.

import type {
  ReleaseVersionCarrier,
  ReleaseVersionCarrierKind,
  ReleaseVersionDecision,
} from '@forge/contracts/releases';
import { RELEASE_VERSION_CARRIER_KINDS } from '@forge/contracts/releases';
import { readAbortStamp } from './abort-stamp.js';
import {
  compareReleaseVersions,
  formatReleaseVersion,
  isStorableReleaseVersion,
  nextReleaseVersion,
  type PrereleaseLine,
  parseReleaseVersion,
  type ReleaseVersion,
} from './version.js';

/** One release-batch run as the rule reads it. */
export interface LineageRun {
  id: string;
  version: string;
  startedAt: Date;
  status: string;
  /** Its ship stamp; a version that shipped is its release's for good. */
  releasedAt: Date | null;
  /** When the run ended, where it has. */
  endedAt: Date | null;
  /** The roster it was cut with (`metadata.issueIds`). */
  roster: readonly string[];
  /** A release job of it was ever taken by a box (dispatched, or held by a master). */
  reachedBox: boolean;
  /** It has a release job at all; an ended run with none was refused at the door, never attempted. */
  hasJob: boolean;
  metadata: Record<string, unknown>;
}

export type CarrierReading =
  | { kind: 'none' }
  | { kind: 'carried'; carriers: ReleaseVersionCarrier[] }
  | { kind: 'unknown' };

// The two statuses `pipeline_runs_release_version_uq` leaves out: a row in either no longer holds its number.
const ENDED = new Set(['cancelled', 'failed']);

const shipped = (r: Pick<LineageRun, 'releasedAt'>) => r.releasedAt !== null;

export const isEnded = (r: Pick<LineageRun, 'status' | 'releasedAt'>) =>
  shipped(r) || ENDED.has(r.status);

const endedUnshipped = (r: LineageRun) => !shipped(r) && isEnded(r);

/** An ended run with no release job was refused before it was attempted: it claims no number. */
const attempted = (r: LineageRun) => r.hasJob || !isEnded(r);

/** The roster as a set, spelled once: order and duplicates never make two rosters differ. */
export const rosterKey = (ids: readonly string[]): string => [...new Set(ids)].sort().join(',');

function isCarrierKind(v: unknown): v is ReleaseVersionCarrierKind {
  return (RELEASE_VERSION_CARRIER_KINDS as readonly unknown[]).includes(v);
}

/** The carriers a stored list names; a malformed entry is dropped from a READ, never from a write. */
export function carriersIn(list: unknown): ReleaseVersionCarrier[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) =>
    typeof c === 'object' && c !== null && isCarrierKind((c as { kind?: unknown }).kind)
      ? typeof (c as { name?: unknown }).name === 'string'
        ? [
            {
              kind: (c as { kind: ReleaseVersionCarrierKind }).kind,
              name: (c as { name: string }).name,
            },
          ]
        : []
      : [],
  );
}

/** The name an unnamed push reads by: the abort said `pushed:true` and named neither the tag nor the commit. */
export const UNNAMED_PUSH: ReleaseVersionCarrier = {
  kind: 'commit',
  name: 'a release commit or tag this attempt said it pushed (pushed: true), naming neither',
};

/**
 * What outside Forge carries the version an ended attempt wore. Named carriers win; `pushed:false`
 * or a declaration naming none says nothing does; an attempt no box ever took did nothing outside
 * Forge; any other silence is `unknown` — a pushed tag is invisible from here.
 */
export function carriersOf(run: Pick<LineageRun, 'metadata' | 'reachedBox'>): CarrierReading {
  const abort = readAbortStamp(run.metadata);
  const declared = run.metadata.carried as { carriers?: unknown } | undefined;
  const named = carriersIn(declared?.carriers);
  if (abort?.pushed === true && named.length === 0) named.push(UNNAMED_PUSH);
  if (named.length > 0) return { kind: 'carried', carriers: named };
  if (declared !== undefined || abort?.pushed === false) return { kind: 'none' };
  return run.reachedBox ? { kind: 'unknown' } : { kind: 'none' };
}

/** The attempt `run` re-cuts: the latest earlier run on the same roster, where that one ended unshipped. */
export function predecessorOf(
  runs: readonly LineageRun[],
  roster: readonly string[],
  before: Date | null,
  self: string | null,
): LineageRun | null {
  const key = rosterKey(roster);
  let latest: LineageRun | null = null;
  for (const r of runs) {
    if (r.id === self || !attempted(r) || rosterKey(r.roster) !== key) continue;
    if (before && r.startedAt.getTime() >= before.getTime()) continue;
    if (!latest || isLater(r, latest)) latest = r;
  }
  return latest && endedUnshipped(latest) ? latest : null;
}

const isLater = (a: LineageRun, b: LineageRun) =>
  a.startedAt.getTime() > b.startedAt.getTime() ||
  (a.startedAt.getTime() === b.startedAt.getTime() && a.id > b.id);

/** Which release each attempt belongs to, and each release's attempts. */
export interface Lineage {
  /** Each attempted run's release, named by the run its chain ends at. */
  headOf: Map<string, LineageRun>;
  /** Each chain head's attempts, first first. */
  attemptsOf: Map<string, LineageRun[]>;
}

/**
 * Chains each attempted run to the one it re-cut. A run has at most one successor: of two later
 * runs on its roster, the second re-cuts the first, never it.
 */
export function lineageOf(runs: readonly LineageRun[]): Lineage {
  const ordered = runs.filter(attempted).sort((a, b) => (isLater(a, b) ? 1 : -1));
  const next = new Map<string, LineageRun>();
  const roots: LineageRun[] = [];
  for (const r of ordered) {
    const pred = predecessorOf(ordered, r.roster, r.startedAt, r.id);
    if (pred) next.set(pred.id, r);
    else roots.push(r);
  }
  const headOf = new Map<string, LineageRun>();
  const attemptsOf = new Map<string, LineageRun[]>();
  for (const root of roots) {
    const chain = [root];
    for (let at = next.get(root.id); at; at = next.get(at.id)) chain.push(at);
    const head = chain[chain.length - 1] as LineageRun;
    attemptsOf.set(head.id, chain);
    for (const r of chain) headOf.set(r.id, head);
  }
  return { headOf, attemptsOf };
}

export type VersionDecision =
  | { kind: 'first'; version: string }
  | { kind: 'reused'; version: string; recutOf: LineageRun; attempt: number }
  | {
      kind: 'bumped';
      version: string;
      recutOf: LineageRun;
      attempt: number;
      carriers: ReleaseVersionCarrier[];
      line: string | null;
      /** A run of another release that already wears `recutOf.version`, where one does. */
      takenBy: string | null;
    }
  | { kind: 'undecided'; version: string; recutOf: LineageRun; silent: LineageRun; attempt: number }
  | { kind: 'exhausted'; next: ReleaseVersion }
  | { kind: 'behind'; next: ReleaseVersion; highest: ReleaseVersion };

/** The highest version any attempt claimed: every cut that was attempted, shipped or not. */
export function highestClaimed(runs: readonly LineageRun[]): ReleaseVersion | null {
  let highest: ReleaseVersion | null = null;
  for (const r of runs) {
    if (!attempted(r)) continue;
    const v = parseReleaseVersion(r.version);
    if (v && (!highest || compareReleaseVersions(v, highest) > 0)) highest = v;
  }
  return highest;
}

function freshVersion(
  runs: readonly LineageRun[],
  line: PrereleaseLine | null,
): { ok: true; version: string } | { ok: false; decision: VersionDecision } {
  const highest = highestClaimed(runs);
  const next = nextReleaseVersion(highest, line);
  if (!isStorableReleaseVersion(next)) return { ok: false, decision: { kind: 'exhausted', next } };
  if (highest && compareReleaseVersions(next, highest) <= 0) {
    return { ok: false, decision: { kind: 'behind', next, highest } };
  }
  return { ok: true, version: formatReleaseVersion(next) };
}

/** Whether `version` is one the declared line would hand out: its core and label, or no line and no label. */
function onLine(version: string, line: PrereleaseLine | null): boolean {
  const v = parseReleaseVersion(version);
  if (!v) return false;
  if (!line) return v.pre === undefined;
  return (
    v.pre?.label === line.label &&
    v.major === line.of.major &&
    v.minor === line.of.minor &&
    v.patch === line.of.patch
  );
}

const lineName = (line: PrereleaseLine) => `${formatReleaseVersion(line.of)}-${line.label}`;

/**
 * The version a cut of `roster` wears, decided against every run the project has (the new run
 * excluded). A roster no unshipped attempt carried is a new release on a new version; a re-cut keeps
 * its predecessor's version unless any attempt that wore it is carried outside Forge or the line
 * moved, and is undecided while any attempt that wore it never said.
 */
export function decideVersion(
  runs: readonly LineageRun[],
  roster: readonly string[],
  line: PrereleaseLine | null,
): VersionDecision {
  const pred = predecessorOf(runs, roster, null, null);
  if (!pred) {
    const fresh = freshVersion(runs, line);
    return fresh.ok ? { kind: 'first', version: fresh.version } : fresh.decision;
  }
  const { headOf, attemptsOf } = lineageOf(runs);
  const chain = attemptsOf.get(headOf.get(pred.id)?.id ?? pred.id) ?? [pred];
  const attempt = chain.length + 1;
  const wearers = chain.filter((r) => r.version === pred.version);
  const carriers: ReleaseVersionCarrier[] = [];
  let silent: LineageRun | null = null;
  for (const r of wearers) {
    const reading = carriersOf(r);
    if (reading.kind === 'carried') carriers.push(...reading.carriers);
    if (reading.kind === 'unknown' && !silent) silent = r;
  }
  const moved = !onLine(pred.version, line);
  // A cut before ADR 0011 could hand an unshipped number to a different roster; that version names
  // another release now, so wearing it again would make it name two deliveries.
  const inChain = new Set(chain.map((r) => r.id));
  const taken = runs.find((r) => r.version === pred.version && !inChain.has(r.id) && attempted(r));
  if (carriers.length > 0 || moved || taken) {
    const fresh = freshVersion(runs, line);
    if (!fresh.ok) return fresh.decision;
    return {
      kind: 'bumped',
      version: fresh.version,
      recutOf: pred,
      attempt,
      carriers,
      line: moved && line ? lineName(line) : null,
      takenBy: taken ? taken.id : null,
    };
  }
  if (silent) return { kind: 'undecided', version: pred.version, recutOf: pred, silent, attempt };
  return { kind: 'reused', version: pred.version, recutOf: pred, attempt };
}

/** What a cut records on its run of the rule it was given: the page reads it back word for word. */
export interface VersionCutRecord {
  decided: Exclude<ReleaseVersionDecision, 'unrecorded'>;
  recutOf: string | null;
  from: string | null;
  attempt: number;
  carriers: ReleaseVersionCarrier[];
  line: string | null;
  takenBy: string | null;
}

export function cutRecordOf(
  d: Extract<VersionDecision, { kind: 'first' | 'reused' | 'bumped' }>,
): VersionCutRecord {
  if (d.kind === 'first') {
    return {
      decided: 'first',
      recutOf: null,
      from: null,
      attempt: 1,
      carriers: [],
      line: null,
      takenBy: null,
    };
  }
  return {
    decided: d.kind,
    recutOf: d.recutOf.id,
    from: d.recutOf.version,
    attempt: d.attempt,
    carriers: d.kind === 'bumped' ? d.carriers : [],
    line: d.kind === 'bumped' ? d.line : null,
    takenBy: d.kind === 'bumped' ? d.takenBy : null,
  };
}
