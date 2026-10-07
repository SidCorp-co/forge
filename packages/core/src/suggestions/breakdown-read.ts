/**
 * A proposed breakdown as its accept would file it (ISS-278, FB-90): each slice read from the stored
 * payload, its design and blockers resolved at the requirement's head by the rules the accept applies,
 * so a person judges the slices before their issues exist. A read, never a write; where the accept
 * would refuse, the slice carries that refusal rather than a guess.
 */

import {
  SUGGESTION_PAYLOADS,
  type SuggestionBreakdownBlocker,
  type SuggestionBreakdownRead,
  type SuggestionBreakdownSlice,
} from '@forge/contracts/suggestions';
import { inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { latestBaselineIn, rowIn } from '../requirements/index.js';
import { type Breakdown, namedBlockersIn, pinnedDesignsIn } from './breakdown.js';
import type { Row } from './read.js';
import { blockerFaults, breakdownBuilds, payloadRefusal } from './rules.js';

/** The pinned designs at `head`, each with the design revision the latest baseline pins it at. */
async function pinnedAt(tx: Tx, requirementId: string, head: number | null) {
  const baseline = head === null ? null : await latestBaselineIn(tx, requirementId, head);
  const pins = (baseline?.pins ?? []).filter((pin) => pin.workflowId !== null);
  const revisionOf = new Map(pins.map((pin) => [pin.workflowId as string, pin.designRevision]));
  const designs = await pinnedDesignsIn(
    tx,
    pins.map((pin) => pin.workflowId as string),
  );
  return { designs, revisionOf };
}

/** Each blockedBy entry as the accept would write its edge, or the refusal it would give: a slice by
 *  index through the accept's own blockerFaults, an issue by key through its namedBlockersIn. */
async function blockersIn(tx: Tx, projectId: string, p: Breakdown) {
  const named = await namedBlockersIn(tx, projectId, p);
  const refusedAt = new Map([...blockerFaults(p), ...named.refusals].map((r) => [r.path, r]));
  const ids = [...new Set(named.ids.values())];
  const rows = ids.length
    ? await tx
        .select({
          id: issues.id,
          issSeq: issues.issSeq,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(inArray(issues.id, ids))
    : [];
  const prefix = rows.length ? await activeIssuePrefix(projectId) : '';
  const byId = new Map(rows.map((r) => [r.id, r]));
  return p.issues.map((item, i) =>
    (item.blockedBy ?? []).map((ref, j): SuggestionBreakdownBlocker => {
      const refusal = refusedAt.get(`/payload/issues/${i}/blockedBy/${j}`);
      if (typeof ref === 'number') {
        if (refusal) return refusedBlocker(String(ref), refusal);
        const sibling = p.issues[ref];
        if (!sibling)
          throw new Error(
            `breakdown-read: blockedBy index ${ref} passed blockerFaults yet names no slice`,
          );
        return { slice: ref, title: sibling.title };
      }
      const row = byId.get(named.ids.get(ref) ?? '');
      if (refusal || !row) return refusedBlocker(ref, refusal);
      return { issue: formatIssueRef(prefix, row.issSeq), title: row.title, status: row.status };
    }),
  );
}

function refusedBlocker(ref: string, refusal: Refusal | undefined): SuggestionBreakdownBlocker {
  return {
    ref,
    code: refusal?.code ?? 'SUGGESTION_BLOCKER_UNKNOWN',
    refusal: refusal?.detail ?? `blockedBy entry "${ref}" names no issue of this project.`,
  };
}

/** The read of one proposed breakdown row on a requirement. */
export async function breakdownReadIn(
  tx: Tx,
  projectId: string,
  row: Row,
): Promise<SuggestionBreakdownRead> {
  const requirement = await rowIn(tx, projectId, row.requirementId as string);
  const head = requirement.currentRevision;
  const unparsed = payloadRefusal('breakdown', 'requirement', row.payload);
  if (unparsed) {
    return {
      revision: head,
      slices: [],
      uncovered: [],
      unreadable: `${unparsed.code} at ${unparsed.path}: ${unparsed.detail}`,
    };
  }
  const p = SUGGESTION_PAYLOADS.breakdown.schema.parse(row.payload);
  const { designs, revisionOf } = await pinnedAt(tx, requirement.id, head);
  const planned = breakdownBuilds(p, designs);
  const buildsRefused = new Map(planned.refusals.map((r) => [r.path, r.detail]));
  const blockers = await blockersIn(tx, projectId, p);
  const slices = p.issues.map((item, i): SuggestionBreakdownSlice => {
    const design = planned.builds[i] ?? null;
    return {
      title: item.title,
      description: item.description ?? null,
      complexity: item.complexity,
      criteria: item.criteria.map((c) => ({ code: c.tracesTo, body: c.body })),
      builds: design
        ? { flow: design.flow, designRevision: revisionOf.get(design.workflowId) ?? null }
        : null,
      buildsRefusal: buildsRefused.get(`/payload/issues/${i}/builds`) ?? null,
      blockedBy: blockers[i] ?? [],
    };
  });
  return { revision: head, slices, uncovered: p.uncovered ?? [], unreadable: null };
}
