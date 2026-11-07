/**
 * ISS-1126 — when the release sweep cuts (REQ-71 r5 BC-13..15, the owner's release cutoff, FB-578).
 *
 * Before it, `release-sweep.ts` cut as soon as one earned issue reached the gate: one release, and on
 * forge-dev one release commit, per recording, which moved `dev` under running landing chains. Now
 * the sweep cuts when the first of the project's triggers is met (`@forge/contracts/release-cutoff`,
 * policy data with Forge's default), and carries only what is eligible:
 *
 * - An outcome is a requirement (REQ) or a feedback item (FB) the issue delivers. It is eligible only
 *   when every issue delivering it has landed with its criteria earned (BC-14): each one is at the
 *   gate and weighed eligible by the sweep, or already past it (claimed by a release, or closed and
 *   carried by none). One still in flight (any status but `draft`, `dropped`, `awaiting_release` and
 *   `closed`), or held at the gate, keeps the outcome out, and every issue delivering it waits.
 *   An issue delivering no outcome is an outcome of its own.
 * - The triggers weigh the eligible outcomes: `time` once the oldest has waited its minutes, `count`
 *   once that many wait or the oldest has waited its maximum, `target` once the named one is eligible
 *   or the oldest has waited its maximum. `request` is the manual cut, which the sweep never takes.
 *   An outcome has waited since its last issue reached the gate.
 * - The cut is `createReleaseBatch` as before: its claim freezes the roster and its version in one
 *   transaction (BC-15), so work that lands after the cut waits for the next one. Forge reads no
 *   commit to decide what is live (`release-is-the-agents-record`).
 *
 * Every row that waits says why on its hold (`hold.ts`): the trigger pending and when its wait ends,
 * or the outcome's issues still missing.
 */

import {
  RELEASE_MAX_WAIT_DEFAULT_MINUTES,
  type ReleaseCutoff,
  type ReleaseTrigger,
  releaseCutoffOf,
} from '@forge/contracts/release-cutoff';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueDisplayIds, waitingForReleaseSql } from '../issues/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { atUtcMinute } from './utc-minute.js';

const MINUTE_MS = 60_000;

/** One eligible outcome the triggers weigh: its key, the issues it carries, when it became eligible. */
export interface CutoffItem {
  /** `REQ-71`, `FB-578`, or the issue's own key where it delivers no outcome. */
  key: string;
  issueIds: string[];
  /** When its last waiting issue reached the gate. */
  since: Date;
}

/** An outcome kept out because an issue delivering it has not landed earned, and those issues. */
export interface IncompleteOutcome {
  key: string;
  /** The keys of the issues delivering it that have not landed with their criteria earned. */
  missing: string[];
}

/** What the sweep may carry, and why each other eligible row waits. */
export interface OutcomeReading {
  items: CutoffItem[];
  /** Per eligible issue kept out, the outcomes it delivers that are incomplete. */
  incomplete: Map<string, IncompleteOutcome[]>;
}

/** The trigger that cut, or each trigger still pending and when the soonest one's wait ends. */
export type CutoffDecision =
  | { cut: true; by: ReleaseTrigger['kind']; says: string }
  | { cut: false; pending: PendingTrigger[] };

export interface PendingTrigger {
  kind: ReleaseTrigger['kind'];
  /** When this trigger cuts though nothing more arrives; null where only an arrival meets it. */
  endsAt: Date | null;
  says: string;
}

const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE_MS);
const stamp = (at: Date) => atUtcMinute(at.toISOString());

/**
 * Whether `items` cut a release at `now` under `cutoff`: the first trigger met, in the order the
 * policy declares them. Pure. No item cuts nothing and leaves nothing pending.
 */
export function decideCutoff(
  cutoff: ReleaseCutoff,
  items: CutoffItem[],
  now: Date,
): CutoffDecision {
  if (items.length === 0) return { cut: false, pending: [] };
  const oldest = items.reduce((a, b) => (b.since < a.since ? b : a));
  const pending: PendingTrigger[] = [];
  const waited = `the oldest eligible outcome, ${oldest.key}, has waited since ${stamp(oldest.since)}`;
  for (const t of cutoff.triggers) {
    if (t.kind === 'request') continue;
    if (t.kind === 'time') {
      const endsAt = plus(oldest.since, t.minutes);
      if (now >= endsAt)
        return { cut: true, by: 'time', says: `${waited}, ${t.minutes} min or more` };
      pending.push({ kind: 'time', endsAt, says: `time: ${waited}; it cuts at ${stamp(endsAt)}` });
      continue;
    }
    const maxWait = t.maxWaitMinutes ?? RELEASE_MAX_WAIT_DEFAULT_MINUTES;
    const endsAt = plus(oldest.since, maxWait);
    const timedOut = now >= endsAt;
    if (t.kind === 'count') {
      if (items.length >= t.outcomes) {
        return {
          cut: true,
          by: 'count',
          says: `${items.length} eligible outcomes, of ${t.outcomes}`,
        };
      }
      if (timedOut)
        return { cut: true, by: 'count', says: `${waited}, its maximum wait of ${maxWait} min` };
      pending.push({
        kind: 'count',
        endsAt,
        says: `count: ${items.length} of ${t.outcomes} eligible outcomes; its maximum wait ends at ${stamp(endsAt)}`,
      });
      continue;
    }
    if (items.some((i) => i.key === t.outcome)) {
      return { cut: true, by: 'target', says: `${t.outcome} is eligible` };
    }
    if (timedOut)
      return { cut: true, by: 'target', says: `${waited}, its maximum wait of ${maxWait} min` };
    pending.push({
      kind: 'target',
      endsAt,
      says: `target: ${t.outcome} is not eligible yet; its maximum wait ends at ${stamp(endsAt)}`,
    });
  }
  return { cut: false, pending };
}

/** The pending trigger whose wait ends first, the one a reader acts on. */
export function soonestPending(pending: readonly PendingTrigger[]): PendingTrigger | null {
  const timed = pending.filter((p) => p.endsAt !== null);
  if (timed.length === 0) return pending[0] ?? null;
  return timed.reduce((a, b) => ((b.endsAt as Date) < (a.endsAt as Date) ? b : a));
}

/** The project's cutoff, its document's or Forge's default, and which said it. */
export async function readCutoff(
  projectId: string,
): Promise<{ cutoff: ReleaseCutoff; from: 'project' | 'default' }> {
  return releaseCutoffOf((await readProjectDocument(projectId))?.document);
}

interface DeliveredRow {
  issue_id: string;
  outcome_id: string;
  outcome_key: string;
}

interface SiblingRow {
  outcome_id: string;
  id: string;
  project_id: string;
  status: string;
  waiting: boolean;
  claimed: boolean;
}

const ids = (list: readonly string[]) =>
  sql.join(
    list.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** Each eligible issue's outcomes: its requirement, and every feedback item routed to it. */
async function outcomesOf(eligible: readonly string[]): Promise<DeliveredRow[]> {
  return (await db.execute(sql`
    SELECT i.id::text AS issue_id, r.id::text AS outcome_id, 'REQ-' || r.req_seq AS outcome_key
      FROM issues i JOIN requirements r ON r.id = i.requirement_id
     WHERE i.id IN (${ids(eligible)})
    UNION ALL
    SELECT fri.issue_id::text, f.id::text, 'FB-' || f.fb_seq
      FROM feedback_route_issues fri JOIN feedback f ON f.id = fri.feedback_id
     WHERE fri.issue_id IN (${ids(eligible)})
  `)) as unknown as DeliveredRow[];
}

/** Every issue delivering each outcome, but drafts and dropped ones, with where it stands. */
async function deliverersOf(outcomeIds: readonly string[]): Promise<SiblingRow[]> {
  if (outcomeIds.length === 0) return [];
  return (await db.execute(sql`
    WITH delivering AS (
      SELECT i.requirement_id AS outcome_id, i.id FROM issues i
       WHERE i.requirement_id IN (${ids(outcomeIds)})
      UNION
      SELECT fri.feedback_id, fri.issue_id FROM feedback_route_issues fri
       WHERE fri.feedback_id IN (${ids(outcomeIds)})
    )
    SELECT d.outcome_id::text, i.id::text, i.project_id::text, i.status,
           ${waitingForReleaseSql(sql`i`)} AS waiting,
           (i.release_batch_run_id IS NOT NULL) AS claimed
      FROM delivering d JOIN issues i ON i.id = d.id
     WHERE i.status NOT IN ('draft', 'dropped')
  `)) as unknown as SiblingRow[];
}

/** When each issue last reached the gate: its newest move into `awaiting_release`, else its merge. */
async function arrivals(issueIds: readonly string[]): Promise<Map<string, Date>> {
  const rows = (await db.execute(sql`
    SELECT i.id::text AS id,
           coalesce((SELECT max(c.created_at) FROM kernel_transitions c
                      WHERE c.entity = 'issue' AND c.entity_id = i.id
                        AND c.to_status = 'awaiting_release'),
                    i.merged_at, i.updated_at) AS since
      FROM issues i WHERE i.id IN (${ids(issueIds)})
  `)) as unknown as Array<{ id: string; since: Date | string }>;
  return new Map(rows.map((r) => [r.id, new Date(r.since)]));
}

/**
 * Whether a sibling has landed with its criteria earned, as BC-14 reads it: weighed eligible at this
 * project's gate this tick, claimed by a release, or past the gate. Another project's issue at its
 * own gate is that project's sweep to weigh, so its landing is enough here.
 */
function landedEarned(s: SiblingRow, projectId: string, eligible: ReadonlySet<string>): boolean {
  if (s.claimed || eligible.has(s.id)) return true;
  if (s.status !== 'awaiting_release' && s.status !== 'closed') return false;
  return !s.waiting || s.project_id !== projectId;
}

/**
 * The eligible outcomes among `eligible` (issue ids the sweep weighed eligible this tick), and per
 * issue kept out the outcomes that keep it. An issue is carried only when every outcome it delivers
 * is eligible.
 */
export async function readOutcomes(
  projectId: string,
  eligible: readonly string[],
): Promise<OutcomeReading> {
  if (eligible.length === 0) return { items: [], incomplete: new Map() };
  const delivered = await outcomesOf(eligible);
  const outcomeKey = new Map(delivered.map((d) => [d.outcome_id, d.outcome_key]));
  const siblings = await deliverersOf([...outcomeKey.keys()]);
  const eligibleSet = new Set(eligible);
  const missingIds = new Map<string, string[]>();
  for (const s of siblings) {
    if (landedEarned(s, projectId, eligibleSet)) continue;
    missingIds.set(s.outcome_id, [...(missingIds.get(s.outcome_id) ?? []), s.id]);
  }
  const keys = await issueDisplayIds([
    ...new Set([...eligible, ...[...missingIds.values()].flat()]),
  ]);
  const keyOf = (id: string) => keys.get(id) ?? id;
  const since = await arrivals(eligible);

  const byIssue = new Map<string, string[]>();
  for (const d of delivered)
    byIssue.set(d.issue_id, [...(byIssue.get(d.issue_id) ?? []), d.outcome_id]);
  const incomplete = new Map<string, IncompleteOutcome[]>();
  const items = new Map<string, CutoffItem>();
  const join = (key: string, issueId: string) => {
    const at = since.get(issueId) ?? new Date(0);
    const held = items.get(key);
    if (!held) {
      items.set(key, { key, issueIds: [issueId], since: at });
      return;
    }
    held.issueIds.push(issueId);
    if (at > held.since) held.since = at;
  };
  for (const issueId of eligible) {
    const outcomes = byIssue.get(issueId) ?? [];
    const short = outcomes.flatMap((o) => {
      const missing = missingIds.get(o);
      return missing ? [{ key: outcomeKey.get(o) ?? o, missing: missing.map(keyOf).sort() }] : [];
    });
    if (short.length > 0) {
      incomplete.set(issueId, short);
      continue;
    }
    if (outcomes.length === 0) join(keyOf(issueId), issueId);
    for (const o of outcomes) join(outcomeKey.get(o) ?? o, issueId);
  }
  return { items: [...items.values()], incomplete };
}

/** The issues `items` carry, once each, in the order the sweep weighed them. */
export function carriedBy(items: readonly CutoffItem[], eligible: readonly string[]): string[] {
  const carried = new Set(items.flatMap((i) => i.issueIds));
  return eligible.filter((id) => carried.has(id));
}
