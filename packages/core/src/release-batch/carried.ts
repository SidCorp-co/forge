/**
 * Which landed issues a release's range carries, and whether each holds a decision (ISS-1386).
 *
 * A batch names the issues at its gate; the promotion ships every landing in its range. An issue
 * landed there but parked at `needs_info`, being judged, or simply unnamed reached production with
 * nobody deciding it should. Every such issue is named here and must carry one of three decisions:
 * `ship-unverified` with what is unverified, `revert` once its landing is reverted inside the
 * range, or `cut-below`, which moves the cut to the first parent of its landing.
 *
 * `readCarried` makes the repository reads and the one database read; `judgeCarried` is pure, so
 * every rule below is decided in one place a test can reach without a network.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import type { RangeCommit } from '../projects/repository-reader.js';
import { readProjectBranches } from '../projects/service.js';
import { type CutRangeDeps, type ReadRange, readRangeTo } from './cut-range.js';

export const CARRIED_DECISIONS = ['ship-unverified', 'revert', 'cut-below'] as const;
export type CarriedDecisionKind = (typeof CARRIED_DECISIONS)[number];

export interface CarriedDecision {
  issueId: string;
  decision: CarriedDecisionKind;
  /** What is unverified; owed by `ship-unverified` and read by nothing else. */
  why?: string | undefined;
}

/** An issue of the project whose landing commit lies in the range. */
export interface LandedIssue {
  issueId: string;
  displayId: string;
  status: string;
  landing: string;
}

export interface CarriedIssue extends LandedIssue {
  decision: CarriedDecisionKind | null;
  why?: string;
}

export interface RefusedDecision {
  issueId: string;
  displayId: string;
  decision: CarriedDecisionKind;
  why: string;
}

type Unread = { kind: 'not-read' | 'unbound' | 'unread'; why: string };

export type CarriedReading =
  | Unread
  | { kind: 'read'; original: ReadRange; final: ReadRange; landed: LandedIssue[] };

export type CarriedCheck =
  | Unread
  | {
      kind: 'read';
      live: string;
      start: string;
      /** The commit this release promotes. */
      cut: string;
      carried: CarriedIssue[];
      undecided: CarriedIssue[];
      /** Issues a `cut-below` took out of the range. */
      cutBelow: CarriedIssue[];
      refused: RefusedDecision[];
      /** Roster members whose landing the moved cut leaves above it. */
      droppedRoster: LandedIssue[];
    };

/** Two names for one commit: equal, or one an abbreviation (seven or more) of the other. */
function sameSha(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

/** Whether `landing` names one of these commits; a stored landing may be abbreviated. */
function holds(shas: readonly string[], landing: string): boolean {
  return shas.some((sha) => sameSha(sha, landing));
}

const REVERTS = /This reverts commit ([0-9a-f]{7,40})/gi;

function reverts(commit: RangeCommit, sha: string): boolean {
  return [...commit.message.matchAll(REVERTS)].some((m) => sameSha(String(m[1]), sha));
}

/** A commit of the range reverting `landing` that no commit of the range reverts in turn. */
function effectivelyReverted(range: ReadRange, landing: string): boolean {
  return range.commits.some(
    (r) => reverts(r, landing) && !range.commits.some((c) => reverts(c, r.sha)),
  );
}

function refuseDecision(
  decision: CarriedDecision,
  issue: LandedIssue | undefined,
  inFinal: boolean,
  final: ReadRange,
): string | null {
  if (!issue) {
    return 'this release range carries no landing of it, so there is nothing to decide';
  }
  if (decision.decision === 'ship-unverified' && !decision.why?.trim()) {
    return '`ship-unverified` says what is unverified, and this one says nothing';
  }
  if (decision.decision === 'revert' && inFinal && !effectivelyReverted(final, issue.landing)) {
    return `no commit up to the cut reverts its landing ${issue.landing.slice(0, 12)} without being reverted in turn; revert it on \`${final.start}\` first`;
  }
  if (decision.decision === 'cut-below' && inFinal) {
    return `the cut at ${final.cut.slice(0, 12)} still carries its landing`;
  }
  return null;
}

/** Every rule of the carried check, over readings already taken. */
export function judgeCarried(
  reading: CarriedReading,
  rosterIds: readonly string[],
  decisions: readonly CarriedDecision[],
): CarriedCheck {
  if (reading.kind !== 'read') return reading;
  const { original, final, landed } = reading;
  const finalShas = final.commits.map((c) => c.sha);
  const roster = new Set(rosterIds.map((id) => id.toLowerCase()));
  const offRoster = landed.filter((i) => !roster.has(i.issueId.toLowerCase()));
  const byId = new Map(offRoster.map((i) => [i.issueId.toLowerCase(), i]));
  const decided = new Map<string, CarriedDecision>();
  const refused: RefusedDecision[] = [];
  for (const d of decisions) {
    const issue = byId.get(d.issueId.toLowerCase());
    const inFinal = issue ? holds(finalShas, issue.landing) : false;
    const why = refuseDecision(d, issue, inFinal, final);
    if (why) {
      refused.push({
        issueId: d.issueId,
        displayId: issue?.displayId ?? d.issueId,
        decision: d.decision,
        why,
      });
    } else {
      decided.set(d.issueId.toLowerCase(), d);
    }
  }
  const withDecision = (i: LandedIssue): CarriedIssue => {
    const d = decided.get(i.issueId.toLowerCase());
    return { ...i, decision: d?.decision ?? null, ...(d?.why ? { why: d.why.trim() } : {}) };
  };
  const carried = offRoster.filter((i) => holds(finalShas, i.landing)).map(withDecision);
  const refusedIds = new Set(refused.map((r) => r.issueId.toLowerCase()));
  return {
    kind: 'read',
    live: final.live,
    start: final.start,
    cut: final.cut,
    carried,
    undecided: carried.filter(
      (i) => i.decision === null && !refusedIds.has(i.issueId.toLowerCase()),
    ),
    cutBelow: offRoster
      .filter(
        (i) =>
          !holds(finalShas, i.landing) &&
          decided.get(i.issueId.toLowerCase())?.decision === 'cut-below',
      )
      .map(withDecision),
    refused,
    droppedRoster: landed.filter(
      (i) =>
        roster.has(i.issueId.toLowerCase()) &&
        holds(
          original.commits.map((c) => c.sha),
          i.landing,
        ) &&
        !holds(finalShas, i.landing),
    ),
  };
}

async function landedIn(projectId: string, shas: readonly string[]): Promise<LandedIssue[]> {
  if (shas.length === 0) return [];
  const rows = await db.execute<{ id: string; status: string; landing: string }>(sql`
    SELECT i.id, i.status, i.merged_commit_sha AS landing
    FROM issues i
    WHERE i.project_id = ${projectId}
      AND i.merged_commit_sha IS NOT NULL
      AND length(i.merged_commit_sha) >= 7
      AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[${sql.join(
          shas.map((s) => sql`${s}`),
          sql`, `,
        )}]::text[]) AS r(sha)
        WHERE r.sha LIKE lower(i.merged_commit_sha) || '%'
      )
    ORDER BY i.iss_seq
  `);
  const shown = await issueDisplayIds(rows.map((r) => r.id));
  return rows.map((r) => ({
    issueId: r.id,
    displayId: shown.get(r.id) ?? r.id,
    status: r.status,
    landing: r.landing.toLowerCase(),
  }));
}

/** The first parent of the earliest `cut-below` landing in the range, or null where none applies. */
function cutBelowSha(
  range: ReadRange,
  landed: LandedIssue[],
  decisions: readonly CarriedDecision[],
): string | null {
  const below = new Set(
    decisions.filter((d) => d.decision === 'cut-below').map((d) => d.issueId.toLowerCase()),
  );
  const at = range.commits.findIndex((c) =>
    landed.some((i) => below.has(i.issueId.toLowerCase()) && holds([c.sha], i.landing)),
  );
  return at < 0 ? null : (range.commits[at]?.parents[0] ?? null);
}

/** The range a release of this project carries, read to the cut its decisions move it to. */
export async function readCarried(
  projectId: string,
  decisions: readonly CarriedDecision[],
  deps: CutRangeDeps = {},
): Promise<CarriedReading> {
  try {
    const chain = (await readProjectBranches(projectId))?.releaseChain ?? [];
    const original = await readRangeTo(projectId, chain, null, deps);
    if (original.kind !== 'read') return original;
    const landed = await landedIn(
      projectId,
      original.commits.map((c) => c.sha),
    );
    const cut = cutBelowSha(original, landed, decisions);
    if (!cut) return { kind: 'read', original, final: original, landed };
    const final = await readRangeTo(projectId, chain, cut, deps);
    if (final.kind !== 'read') return final;
    return { kind: 'read', original, final, landed };
  } catch (err) {
    return { kind: 'unread', why: err instanceof Error ? err.message : String(err) };
  }
}

/** What a release run keeps of its carried check, on its metadata and in its create answer. */
export type CarriedRecord =
  | Unread
  | {
      kind: 'read';
      live: string;
      start: string;
      cut: string;
      issues: CarriedIssue[];
      cutBelow: CarriedIssue[];
    };

export function carriedRecord(check: CarriedCheck | undefined): CarriedRecord | null {
  if (!check) return null;
  if (check.kind !== 'read') return check;
  const { live, start, cut, carried, cutBelow } = check;
  return { kind: 'read', live, start, cut, issues: carried, cutBelow };
}

/** The decision, written on each issue that ships unverified, naming the batch that ships it. */
export async function noteShipUnverified(args: {
  runId: string;
  version: string;
  check: CarriedCheck | undefined;
  userId: string;
}): Promise<void> {
  const { runId, version, check, userId } = args;
  if (check?.kind !== 'read') return;
  const shipped = check.carried.filter((i) => i.decision === 'ship-unverified');
  if (shipped.length === 0) return;
  await db.insert(comments).values(
    shipped.map((i) => ({
      issueId: i.issueId,
      authorId: userId,
      body:
        `Release ${version} (run ${runId}) ships this issue's landing ${i.landing.slice(0, 12)} ` +
        `while it stands at \`${i.status}\` and off the release's roster. Whoever pressed the ` +
        `release decided \`ship-unverified\`: ${i.why ?? ''}`,
    })),
  );
}
