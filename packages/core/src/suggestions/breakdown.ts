/**
 * A breakdown suggestion (workflow requirement-to-delivery steps `breakdown` and `approve`): the
 * guard it passes at propose, revise and accept, and the issues its accept files, sized, traced,
 * edged and linked as the builds of the designs the requirement's baseline pins.
 */

import { requirementKey } from '@forge/contracts/requirements';
import {
  BREAKDOWN_ISSUE_DEFAULTS,
  SUGGESTION_PAYLOADS,
  type SuggestionBreakdownIssue,
} from '@forge/contracts/suggestions';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirementCriteria } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import {
  activeIssuePrefix,
  heldIssuePrefixes,
  insertIssueRow,
  isUuid,
  type PendingIssueRelation,
  putCriteria,
  writeIssueRelations,
} from '../issues/index.js';
import { formatIssueRef, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { latestBaselineIn, linkIssueRefusal, rowIn } from '../requirements/index.js';
import { linkBuild } from '../workflows/index.js';
import type { AcceptChannel, EffectWritten } from './effects.js';
import { type Row, type SuggestionActor, targetOfRow } from './read.js';
import {
  blockerRefusal,
  breakdownBuilds,
  breakdownFaults,
  type PinnedDesign,
  payloadRefusal,
} from './rules.js';

/** The BC wordings live at `revision`, by code. */
async function liveCodes(tx: Tx, requirementId: string, revision: number) {
  const rows = await tx
    .select({ id: requirementCriteria.id, code: requirementCriteria.code })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        sql`${requirementCriteria.sinceRevision} <= ${revision}`,
        sql`(${requirementCriteria.retiredRevision} IS NULL OR ${requirementCriteria.retiredRevision} > ${revision})`,
      ),
    );
  return new Map(rows.map((r) => [r.code, r.id]));
}

type Breakdown = ReturnType<(typeof SUGGESTION_PAYLOADS)['breakdown']['schema']['parse']>;

/** What a breakdown is checked against, at propose and again at accept: the requirement is agreed,
 *  and the payload's traces and blockers hold at `head`. */
/** Each blockedBy entry that names an existing issue, read in the caller's transaction. */
async function namedBlockersIn(tx: Tx, projectId: string, p: Breakdown) {
  const refusals: Refusal[] = [];
  const ids = new Map<string, string>();
  const prefix = await activeIssuePrefix(projectId);
  let held: string[] = [];
  const cols = {
    id: issues.id,
    projectId: issues.projectId,
    issSeq: issues.issSeq,
    status: issues.status,
    archivedAt: issues.archivedAt,
  };
  for (const [i, item] of p.issues.entries()) {
    for (const [j, ref] of (item.blockedBy ?? []).entries()) {
      if (typeof ref !== 'string') continue;
      let unreadable: string | null = null;
      let rows: {
        id: string;
        projectId: string;
        issSeq: number;
        status: string;
        archivedAt: Date | null;
      }[] = [];
      if (isUuid(ref)) {
        rows = await tx.select(cols).from(issues).where(eq(issues.id, ref));
      } else {
        if (issueRefNeedsHeldPrefixes(ref) && !held.length)
          held = await heldIssuePrefixes(projectId);
        const parsed = parseIssueRef(ref, held);
        if (parsed.ok) {
          rows = await tx
            .select(cols)
            .from(issues)
            .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq)));
        } else unreadable = parsed.message;
      }
      const row = rows[0];
      const found = row
        ? {
            key: formatIssueRef(prefix, row.issSeq),
            projectId: row.projectId,
            status: row.status,
            archived: row.archivedAt !== null,
          }
        : null;
      const path = `/payload/issues/${i}/blockedBy/${j}`;
      const refusal = blockerRefusal(path, ref, projectId, found, unreadable);
      if (refusal) refusals.push(refusal);
      else if (row) ids.set(ref, row.id);
    }
  }
  return { refusals, ids };
}

export async function breakdownGuardIn(
  tx: Tx,
  projectId: string,
  requirementId: string,
  head: number | null,
  p: Breakdown,
): Promise<{
  refusals: Refusal[];
  codes: ReadonlyMap<string, string>;
  blockers: ReadonlyMap<string, string>;
  builds: (PinnedDesign | null)[];
  baselineSeq: number | null;
}> {
  const req = await rowIn(tx, projectId, requirementId);
  const notAgreed = linkIssueRefusal(req.status as Parameters<typeof linkIssueRefusal>[0]);
  if (notAgreed || head === null) {
    return {
      refusals: [
        {
          code: notAgreed?.code ?? 'REQUIREMENT_NOT_AGREED',
          path: '/target',
          detail: `${requirementKey(req.reqSeq)} is ${req.status}; a breakdown files issues against an agreed requirement.`,
        },
      ],
      codes: new Map(),
      blockers: new Map(),
      builds: [],
      baselineSeq: null,
    };
  }
  const codes = await liveCodes(tx, req.id, head);
  const named = await namedBlockersIn(tx, projectId, p);
  const baseline = await latestBaselineIn(tx, req.id, head);
  const designs = await pinnedDesignsIn(
    tx,
    (baseline?.pins ?? []).flatMap((pin) => (pin.workflowId ? [pin.workflowId] : [])),
  );
  const planned = breakdownBuilds(p, designs);
  return {
    refusals: [...breakdownFaults(p, codes, head), ...named.refusals, ...planned.refusals],
    codes,
    blockers: named.ids,
    builds: planned.builds,
    baselineSeq: baseline?.seq ?? null,
  };
}

/** The flows of the designs a baseline pins, in flow order. */
async function pinnedDesignsIn(tx: Tx, workflowIds: readonly string[]): Promise<PinnedDesign[]> {
  if (workflowIds.length === 0) return [];
  return tx
    .select({ workflowId: projectWorkflows.id, flow: projectWorkflows.flow })
    .from(projectWorkflows)
    .where(inArray(projectWorkflows.id, [...workflowIds]))
    .orderBy(projectWorkflows.flow);
}

/** A stored breakdown that no longer parses is refused at accept by its path, never thrown. */
function storedBreakdownRefusal(row: Row): Refusal | null {
  const refusal = payloadRefusal('breakdown', 'requirement', row.payload);
  if (!refusal) return null;
  return {
    ...refusal,
    detail: `${refusal.detail} The stored payload does not match this shape; revise the suggestion (POST /suggestions/${row.id}/revise) to it.`,
  };
}

// Workflow requirement-to-delivery step `approve`: core creates every issue with
// requirement_id, planned_revision, issue_criteria and blocks edges in one transaction; they are
// filed at draft, so nothing dispatches before a person promotes them. Each is sized as its item
// says and linked as the build of the pinned design it builds, so the build gate holds it (ISS-117)
type Guarded = Awaited<ReturnType<typeof breakdownGuardIn>>;

/** One item filed as a draft issue pinned at the head, linked as the build of its design, with its criteria. */
async function fileItemIn(
  tx: Tx,
  ctx: {
    projectId: string;
    row: Row;
    requirementId: string;
    head: number;
    actor: SuggestionActor;
    channel: AcceptChannel;
    guard: Guarded;
  },
  item: Breakdown['issues'][number],
  design: PinnedDesign | null,
): Promise<Omit<SuggestionBreakdownIssue, 'key'> & { seq: number }> {
  const { projectId, actor, guard } = ctx;
  const priority = item.priority ?? BREAKDOWN_ISSUE_DEFAULTS.priority;
  const category = item.category ?? BREAKDOWN_ISSUE_DEFAULTS.category;
  const issue = await insertIssueRow(
    tx,
    {
      projectId,
      title: item.title,
      description: item.description ?? null,
      descriptionFormat: 'markdown',
      status: 'draft',
      priority,
      category,
      complexity: item.complexity,
      createdById: actor.userId,
      createdByDeviceId: null,
      createdVia: ctx.channel,
      requirementId: ctx.requirementId,
      plannedRevision: ctx.head,
      plannedBaselineSeq: guard.baselineSeq,
      fromSuggestionId: ctx.row.id,
    },
    { actor: { type: 'user', id: actor.userId, agency: actor.agency } },
  );
  if (design) {
    await linkBuild(tx, {
      issueId: issue.id,
      workflowId: design.workflowId,
      projectId,
      userId: actor.userId,
    });
  }
  await putCriteria(
    tx,
    issue.id,
    item.criteria.map((c, j) => ({
      n: j + 1,
      statement: c.body,
      requirementCriterionId: guard.codes.get(c.tracesTo) ?? null,
    })),
  );
  return {
    issueId: issue.id,
    seq: issue.issSeq,
    priority,
    category,
    complexity: item.complexity,
    builds: design?.flow ?? null,
    defaulted: [
      ...(item.priority === undefined ? (['priority'] as const) : []),
      ...(item.category === undefined ? (['category'] as const) : []),
    ],
  };
}

export async function breakdownEffect(
  tx: Tx,
  projectId: string,
  row: Row,
  head: number | null,
  actor: SuggestionActor,
  channel: AcceptChannel,
): Promise<EffectWritten> {
  const target = targetOfRow(row);
  const unparsed = storedBreakdownRefusal(row);
  if (unparsed) return { refusals: [unparsed] };
  const p = SUGGESTION_PAYLOADS.breakdown.schema.parse(row.payload);
  const guard = await breakdownGuardIn(tx, projectId, target.id, head, p);
  if (guard.refusals.length || head === null) return { refusals: guard.refusals };
  const req = await rowIn(tx, projectId, target.id);
  const ctx = { projectId, row, requirementId: req.id, head, actor, channel, guard };
  const filed: Awaited<ReturnType<typeof fileItemIn>>[] = [];
  for (const [i, item] of p.issues.entries()) {
    filed.push(await fileItemIn(tx, ctx, item, guard.builds[i] ?? null));
  }
  const ids = filed.map((f) => f.issueId);
  const writer = {
    actor: { type: 'user' as const, id: actor.userId, agency: actor.agency },
    createdById: actor.userId,
  };
  const relations: PendingIssueRelation[] = [];
  for (const [i, item] of p.issues.entries()) {
    const edges = (item.blockedBy ?? []).map((k) => ({
      kind: 'blocks' as const,
      dependsOnId: (typeof k === 'number' ? ids[k] : guard.blockers.get(k)) as string,
      reason: `breakdown of ${requirementKey(req.reqSeq)} (suggestion ${row.id})`,
    }));
    relations.push(...(await writeIssueRelations(writer, projectId, ids[i] as string, edges, tx)));
  }
  const prefix = await activeIssuePrefix(projectId);
  return {
    refusals: null,
    relations,
    effect: {
      requirementId: req.id,
      requirement: requirementKey(req.reqSeq),
      revision: head,
      issues: filed.map(({ seq, ...f }) => ({ ...f, key: formatIssueRef(prefix, seq) })),
    },
  };
}
