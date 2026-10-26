/**
 * `GET /needs-you` (ISS-75, ISS-164): what waits on the viewer, area by area, built from the one list
 * the decisions read is built from (`needs-you-decisions-read.ts:needsYouListOf`). Its asks are every row
 * that read makes a decision of or leaves out by why, and every folded proposal, mockup and preview,
 * so a menu count, Development's list, the Dashboard and Approvals count one set (REQ-48 BC-11); a
 * decision the agent may take is the master's, so neither read lists it as the viewer's (REQ-68 BC-3).
 */

import {
  countsAsReport,
  FEEDBACK_UNTRIAGED_PHASES,
  type FeedbackPhase,
} from '@forge/contracts/feedback';
import {
  NEEDS_YOU_AREA_SPACE,
  NEEDS_YOU_AREAS,
  type NeedsYouAct,
  type NeedsYouArea,
  type NeedsYouAreaKey,
  type NeedsYouEntity,
  type NeedsYouItem,
  type NeedsYouResponse,
} from '@forge/contracts/needs-you';
import type { DecisionOpens } from '@forge/contracts/needs-you-decisions';
import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { ProjectAccess } from '../lib/authz.js';
import { type AttentionRow, type NeedsYouViewer, newestFirst, readAttention } from './needs-you.js';
import { needsYouListOf } from './needs-you-decisions-read.js';
import type { Folded } from './needs-you-fold.js';
import { writtenTitle } from './row-title.js';

function areaOf(rows: readonly AttentionRow[]): NeedsYouArea {
  // Tallied by what core said, not by its English, so two acts that read alike stay two.
  const tally = new Map<string, NeedsYouAct>();
  for (const row of rows) {
    const w = row.standing.waitingOn;
    const id = JSON.stringify(w.says.act);
    const seen = tally.get(id);
    tally.set(
      id,
      seen
        ? { ...seen, count: seen.count + 1 }
        : { act: w.act, count: 1, says: { act: w.says.act } },
    );
  }
  const acts = [...tally.values()].sort((a, b) => b.count - a.count || a.act.localeCompare(b.act));
  return { you: rows.length, acts };
}

const UNTRIAGED: ReadonlySet<FeedbackPhase> = new Set(FEEDBACK_UNTRIAGED_PHASES);

const owesAnAgentsProposal = waitingOn('you', {
  who: say('standing.who.you'),
  act: say('needsYou.act.decideProposal'),
  rule: say('needsYou.rule.proposed'),
});

/** A folded record's row, opening the page it is decided on. */
function foldedRow(r: {
  key: string;
  entity: NeedsYouEntity;
  title: string;
  touchedAt: string | null;
  opens: DecisionOpens | null;
}): AttentionRow {
  return {
    entity: r.opens?.kind ?? r.entity,
    key: r.opens?.key ?? r.key,
    ...writtenTitle(r.title || r.key, null),
    standing: { attentionGroup: 'needs_you', waitingOn: owesAnAgentsProposal },
    touchedAt: r.touchedAt,
  };
}

/**
 * The rows of one list, area by area, newest first: each owed row the decisions read makes a decision
 * of or leaves out by why, each folded proposal, mockup and preview (on its owed row where the row is
 * one, else a row of its own), and the ops rows. `/needs-you` lists exactly these, so its asks are
 * the decisions read's `total` plus its `notDecisions` but what the agent takes (REQ-48 BC-11).
 */
function rowsOfList(
  listed: readonly { area: NeedsYouAreaKey; row: AttentionRow }[],
  owedRows: Record<NeedsYouAreaKey, AttentionRow[]>,
  folded: Folded,
): Record<NeedsYouAreaKey, AttentionRow[]> {
  const rows = Object.fromEntries(
    NEEDS_YOU_AREAS.map((a) => [a, NEEDS_YOU_AREA_SPACE[a] === 'asks' ? [] : owedRows[a]]),
  ) as Record<NeedsYouAreaKey, AttentionRow[]>;
  for (const { area, row } of listed) rows[area].push(row);
  const taken = new Set(listed.map(({ row }) => row));
  const ownRowOf = (area: NeedsYouAreaKey, key: string) => {
    const own = owedRows[area].find((r) => r.key === key && !taken.has(r));
    if (own) taken.add(own);
    return own;
  };
  for (const d of folded.decisions) rows[d.area].push(ownRowOf(d.area, d.key) ?? foldedRow(d));
  for (const u of folded.unreadable) rows[u.area].push(foldedRow(u));
  for (const area of NEEDS_YOU_AREAS) rows[area].sort(newestFirst);
  return rows;
}

export async function readNeedsYou(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<NeedsYouResponse> {
  const attention = await readAttention(projectId, viewer, now);
  const { listed, owedRows, folded } = await needsYouListOf(
    projectId,
    viewer,
    access,
    attention,
    now,
  );
  const rows = rowsOfList(listed, owedRows, folded);
  const items = NEEDS_YOU_AREAS.flatMap((area) =>
    rows[area].map(
      (r): NeedsYouItem => ({
        area,
        space: NEEDS_YOU_AREA_SPACE[area],
        entity: r.entity,
        key: r.key,
        title: r.title,
        titleLang: r.titleLang,
        waitingOn: r.standing.waitingOn,
        touchedAt: r.touchedAt,
        says: { title: r.says.title },
      }),
    ),
  );
  return {
    generatedAt: now.toISOString(),
    areas: Object.fromEntries(NEEDS_YOU_AREAS.map((area) => [area, areaOf(rows[area])])) as Record<
      NeedsYouAreaKey,
      NeedsYouArea
    >,
    items,
    requirementsInDelivery: attention.requirements.filter((r) => r.standing.state === 'in_delivery')
      .length,
    untriagedFeedback: attention.feedback.filter((f) => UNTRIAGED.has(f.phase) && countsAsReport(f))
      .length,
  };
}
