/**
 * The one Needs you list and the reads built on it (REQ-48 BC-11): the viewer's decisions classified
 * by `needs-you-decisions.ts:decisionsOf`, every folded proposal, mockup and preview beside them, what
 * the agent takes left out by that reason (REQ-68 BC-3), and a decision that waited 14 days carrying
 * the agent's proposal of its decline (REQ-68 BC-8). `/needs-you` and `/needs-you/decisions` both
 * read from here, so they list one set.
 */

import {
  byDecisionOrder,
  type NeedsYouDecision,
  type NeedsYouDecisions,
  needsYouDecisionsSchema,
  questionDecisionId,
} from '@forge/contracts/needs-you-decisions';
import type { ProjectAccess } from '../lib/authz.js';
import { type NeedsYouViewer, readAttention } from './needs-you.js';
import { agentTakesItem, agentTakesOf } from './needs-you-agent-takes.js';
import { type Attention, decisionsOf } from './needs-you-decisions.js';
import { declineProposed, waitedToPropose } from './needs-you-escalation.js';
import { type EvidenceGroup, withEvidence } from './needs-you-evidence.js';
import { type Folded, foldedDecisions, unreadableItem } from './needs-you-fold.js';

/** How many decisions one answer carries; `total` counts them all. */
const DECISIONS_MAX = 200;
const NOT_DECISION_ITEMS_MAX = 20;

/**
 * A decision that is no question, waited 14 days since it was asked: the agent proposes its decline
 * (REQ-68 BC-8). A question's proposal is stamped on its round by the upkeep sweep (`asked`).
 */
function agedProposal(d: NeedsYouDecision, now: Date): NeedsYouDecision {
  if (d.id.startsWith(questionDecisionId(''))) return d;
  return waitedToPropose(d.touchedAt, now) ? declineProposed(d) : d;
}

/**
 * The one list both Needs you reads are built from (`/needs-you` and `/needs-you/decisions`): every
 * decision of one attention read in the list's order, what was left out by why, and the rows of both.
 */
export async function needsYouListOf(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  attention: Attention,
  now: Date = new Date(),
) {
  const [{ owed, left, listed, owedRows }, folded] = await Promise.all([
    decisionsOf(projectId, attention),
    foldedDecisions(projectId, viewer, access, attention),
  ]);
  if (folded.unreadable.length > 0) left.set('unreadable', folded.unreadable.map(unreadableItem));
  const all = uniqueIds([...owed.map((o) => o.decision), ...folded.decisions])
    .map((d) => agedProposal(d, now))
    .sort(byDecisionOrder);
  const agentTakes = await agentTakesOf(projectId, all);
  const taken = all.filter(agentTakes);
  if (taken.length > 0) left.set('agent_takes', taken.map(agentTakesItem));
  const decisions = all.filter((d) => !agentTakes(d));
  const ids: EvidenceGroup['ids'] = {
    issue: new Map(attention.issues.issues.map((i) => [i.key, i.id])),
    requirement: new Map(attention.requirements.map((r) => [r.key, r.id])),
  };
  // the rows of what the agent takes: `/needs-you` lists none of them, as this read lists none (REQ-68 BC-3)
  const takenRows = new Set(owed.filter((o) => agentTakes(o.decision)).map((o) => o.row));
  const mine: Folded = {
    decisions: folded.decisions.filter((d) => !agentTakes(d)),
    unreadable: folded.unreadable,
  };
  return {
    decisions,
    left,
    ids,
    listed: listed.filter(({ row }) => !takenRows.has(row)),
    owedRows,
    folded: mine,
  };
}

/** The viewer's whole Needs you from an attention read already made: what the status report counts. */
export async function needsYouDecisionsOf(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  attention: Attention,
): Promise<NeedsYouDecision[]> {
  return (await needsYouListOf(projectId, viewer, access, attention)).decisions;
}

/** Each decision's id once in the read, a second built for the same record numbered after it. */
function uniqueIds(decisions: NeedsYouDecision[]): NeedsYouDecision[] {
  const seen = new Map<string, number>();
  return decisions.map((d) => {
    const n = (seen.get(d.id) ?? 0) + 1;
    seen.set(d.id, n);
    return n === 1 ? d : { ...d, id: `${d.id}#${n}` };
  });
}

/**
 * One project's Needs you read without the evidence each decision rests on, and the ids its evidence
 * is read by: the cross-project read reads every project's evidence in one call after it.
 */
export async function readNeedsYouDecisionsBare(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<{ read: NeedsYouDecisions; ids: EvidenceGroup['ids'] }> {
  const attention = await readAttention(projectId, viewer, now);
  const { decisions, left, ids } = await needsYouListOf(projectId, viewer, access, attention, now);
  const read = needsYouDecisionsSchema.parse({
    generatedAt: now.toISOString(),
    decisions: decisions.slice(0, DECISIONS_MAX),
    total: decisions.length,
    notDecisions: [...left].map(([reason, items]) => ({
      reason,
      count: items.length,
      items: items.slice(0, NOT_DECISION_ITEMS_MAX),
    })),
  });
  return { read, ids };
}

/**
 * The one Needs you read (REQ-48 BC-11): the viewer's decisions from their owed rows, and every
 * agent's proposal, mockup and preview waiting on them folded in, each with the evidence it rests on
 * (r3 BC-15). The page, the Dashboard, /attention, the nav and the chat all count `total` from here,
 * so no two surfaces count their own.
 */
export async function readNeedsYouDecisions(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<NeedsYouDecisions> {
  const { read, ids } = await readNeedsYouDecisionsBare(projectId, viewer, access, now);
  const [decisions = []] = await withEvidence([{ decisions: read.decisions, ids }]);
  return needsYouDecisionsSchema.parse({ ...read, decisions });
}
