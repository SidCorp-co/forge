// What the Approvals page draws from the one Needs you read (REQ-48 BC-11), decided nowhere else:
// the groups in page order, what the chips and the search keep, which answer a row's ✓ and ✕ press,
// and what a bulk approve makes, counted from each proposal's own `yields`. Nothing here judges a
// proposal: whether the agent recommends it is core's.

import type { DecisionAnswer, NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { NEEDS_YOU_TOPICS, NEEDS_YOU_YIELDS, type NeedsYouTopic, type NeedsYouYield } from "@forge/contracts/needs-you-proposal";

export const CHIPS = ["all", "feedback", "breakdown", "design_update", "mockup"] as const;
export type Chip = (typeof CHIPS)[number];

export interface Narrowing {
  chip: Chip;
  /** Only what the agent recommends approving as proposed. */
  recommends: boolean;
  query: string;
}

/** Whether the agent recommends approving it as proposed; a decision with no proposal never reads so. */
export const recommends = (d: NeedsYouDecision): boolean => d.proposal?.recommends === true;

/** The words a search reads: key, title, and the proposal or the question. */
const searchText = (d: NeedsYouDecision) =>
  [d.key, d.title, d.proposal ? `${d.proposal.verb} ${d.proposal.what}` : d.question].join(" ").toLowerCase();

export function narrowed(all: readonly NeedsYouDecision[], n: Narrowing): NeedsYouDecision[] {
  const q = n.query.trim().toLowerCase();
  return all.filter((d) => (n.chip === "all" || d.topic === n.chip) && (!n.recommends || recommends(d)) && (!q || searchText(d).includes(q)));
}

/** The page's groups, in topic order, each with its rows in the read's order; empty ones left out. */
export function groupsOf(rows: readonly NeedsYouDecision[]): { topic: NeedsYouTopic; rows: NeedsYouDecision[] }[] {
  return NEEDS_YOU_TOPICS.map((topic) => ({ topic, rows: rows.filter((d) => d.topic === topic) })).filter((g) => g.rows.length > 0);
}

/** The rows in the order the page draws them, which is the order j/k and the peek step through. */
export const drawnOrder = (rows: readonly NeedsYouDecision[]): NeedsYouDecision[] => groupsOf(rows).flatMap((g) => g.rows);

/**
 * The answer a row's ✓ presses: the proposal's approve, else the recommended answer that does not
 * decline, else the only one that does not. A question with several answers and none recommended
 * has none: it is answered in its peek, never guessed. Where the act takes words, the ✓ asks for them.
 */
export function approveOf(d: NeedsYouDecision): DecisionAnswer | null {
  if (d.proposal) return d.answers.find((a) => a.id === "approve") ?? null;
  const yes = d.answers.filter((a) => !a.declines);
  return yes.find((a) => a.recommended) ?? (yes.length === 1 ? (yes[0] ?? null) : null);
}

/** The answer a row's ✕ presses: the one core marks as saying no. A kind with none has no ✕. */
export const declineOf = (d: NeedsYouDecision): DecisionAnswer | null => d.answers.find((a) => a.declines) ?? null;

/** The answers a row's ✓ does not press and its ✕ does not either: what its peek offers besides. */
export const otherAnswersOf = (d: NeedsYouDecision): DecisionAnswer[] => d.answers.filter((a) => a !== approveOf(d) && a !== declineOf(d));

/** What a bulk approve sends for a row: its ✓, where that takes no words a shared approve cannot carry. */
export function bulkApproveOf(d: NeedsYouDecision): DecisionAnswer | null {
  const a = approveOf(d);
  return a && !a.needsReason ? a : null;
}

export interface BulkSummary {
  yields: { kind: NeedsYouYield; n: number }[];
  /** Selected rows the agent asks to be checked first. */
  checkFirst: number;
  /** Selected rows a bulk approve cannot send, left for their peek. */
  noApprove: number;
}

/** What approving the selection makes, before it acts: "19 new issues · 3 requirement revisions · 5 closed". */
export function bulkSummary(selected: readonly NeedsYouDecision[]): BulkSummary {
  const tally = new Map<NeedsYouYield, number>();
  let noApprove = 0;
  for (const d of selected) {
    if (!bulkApproveOf(d)) {
      noApprove += 1;
      continue;
    }
    for (const y of d.proposal?.yields ?? []) tally.set(y.kind, (tally.get(y.kind) ?? 0) + y.n);
  }
  return {
    yields: NEEDS_YOU_YIELDS.flatMap((kind) => (tally.get(kind) ? [{ kind, n: tally.get(kind) as number }] : [])),
    checkFirst: selected.filter((d) => d.proposal && !d.proposal.recommends).length,
    noApprove,
  };
}

/** The oldest wait among the rows, for the page's "oldest 13d". */
export const oldestOf = (rows: readonly NeedsYouDecision[]): string | null =>
  rows.reduce<string | null>((o, d) => (d.touchedAt && (!o || d.touchedAt < o) ? d.touchedAt : o), null);
