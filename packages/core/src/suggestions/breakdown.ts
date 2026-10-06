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
  insertContractWaitIn,
  insertIssueRow,
  isUuid,
  lockContractsIn,
  putCriteria,
  writeIssueRelations,
} from '../issues/index.js';
import { contractVersionReads, type WaitTargetResolved } from '../lib/contract-versions.js';
import { formatIssueRef, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { latestBaselineIn, linkIssueRefusal, rowIn } from '../requirements/index.js';
import { designNodesIn, linkBuild, nodeSetRefusals, observedNodesIn } from '../workflows/index.js';
import type { AcceptChannel, EffectWritten } from './effects.js';
import { type Row, type SuggestionActor, targetOfRow } from './read.js';
import {
  blockerRefusal,
  breakdownBuilds,
  breakdownFaults,
  breakdownWaitTargets,
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
  waits: WaitTargetResolved[][];
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
      waits: [],
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
  const steps = await buildStepRefusals(tx, projectId, p, planned.builds);
  const now = new Date();
  const waits = await breakdownWaitTargets(p, (w) =>
    contractVersionReads().waitTargetIn(tx, { projectId, ...w }, now),
  );
  return {
    refusals: [
      ...breakdownFaults(p, codes, head),
      ...named.refusals,
      ...planned.refusals,
      ...steps,
      ...waits.refusals,
    ],
    codes,
    blockers: named.ids,
    builds: planned.builds,
    waits: waits.waits,
  };
}

/** Every step a breakdown issue names that the design it builds does not hold (design-reconciliation `breakdown`). */
async function buildStepRefusals(
  tx: Tx,
  projectId: string,
  p: Breakdown,
  builds: readonly (PinnedDesign | null)[],
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  for (const [i, issue] of p.issues.entries()) {
    const design = builds[i];
    if (!design) continue;
    if (issue.steps) {
      const nodes = await designNodesIn(tx, projectId, design.workflowId);
      if (nodes)
        out.push(...nodeSetRefusals(nodes, { steps: issue.steps }, `/payload/issues/${i}`));
    }
    if (issue.observedSteps) {
      const base = `/payload/issues/${i}/observedSteps`;
      const nodes = await observedNodesIn(tx, projectId, design.workflowId);
      out.push(
        ...(nodes
          ? nodeSetRefusals(nodes, { steps: issue.observedSteps }, base).map((r) => ({
              ...r,
              path: r.path.replace(`${base}/steps/`, `${base}/`),
            }))
          : [
              {
                code: 'WORKFLOW_NODE_UNKNOWN',
                path: base,
                detail: `workflow ${design.flow} has no observation yet, so a breakdown issue can name no observed step; name planned steps under steps.`,
              },
            ]),
      );
    }
  }
  return out;
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
// requirement_id, planned_revision, issue_criteria, blocks edges and contract waits in one
// transaction; they are filed at draft, so nothing dispatches before a person promotes them. Each is
// sized as its item says and linked as the build of the pinned design it builds, so the build gate
// holds it (ISS-117), and waits on each provider version its item names, so what the person accepted
// is what holds it
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
  const { codes, blockers, builds, waits } = guard;
  await lockContractsIn(tx, waits.flat());
  const req = await rowIn(tx, projectId, target.id);
  const ids: string[] = [];
  const seqOf = new Map<string, number>();
  const filed: Omit<SuggestionBreakdownIssue, 'key'>[] = [];
  for (const [i, item] of p.issues.entries()) {
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
        createdVia: channel,
        requirementId: req.id,
        plannedRevision: head,
        fromSuggestionId: row.id,
      },
      { actor: { type: 'user', id: actor.userId, agency: actor.agency } },
    );
    ids.push(issue.id);
    seqOf.set(issue.id, issue.issSeq);
    const design = builds[i] ?? null;
    if (design) {
      await linkBuild(tx, {
        issueId: issue.id,
        workflowId: design.workflowId,
        projectId,
        userId: actor.userId,
        stepIds: item.steps ? [...new Set(item.steps)] : null,
        observedStepIds: item.observedSteps ? [...new Set(item.observedSteps)] : null,
      });
    }
    const written = [];
    for (const w of waits[i] ?? []) {
      const wait = await insertContractWaitIn(tx, {
        projectId,
        issueId: issue.id,
        providerProjectId: w.providerProjectId,
        contractSlug: w.contractSlug,
        minVersion: w.minVersion,
        reason: `breakdown of ${requirementKey(req.reqSeq)} (suggestion ${row.id})`,
        createdBy: actor.userId,
        dueAt: w.dueAt,
      });
      written.push({
        waitId: wait.id,
        contract: w.contract,
        minVersion: w.minVersion,
        dueAt: w.dueAt?.toISOString() ?? null,
        settledVersion: wait.settledVersion,
      });
    }
    filed.push({
      issueId: issue.id,
      priority,
      category,
      complexity: item.complexity,
      builds: design?.flow ?? null,
      defaulted: [
        ...(item.priority === undefined ? (['priority'] as const) : []),
        ...(item.category === undefined ? (['category'] as const) : []),
      ],
      contractWaits: written,
    });
    const criteria = item.criteria.map((c, j) => ({
      n: j + 1,
      statement: c.body,
      requirementCriterionId: codes.get(c.tracesTo) ?? null,
    }));
    await putCriteria(tx, issue.id, criteria);
  }
  const writer = {
    actor: { type: 'user' as const, id: actor.userId, agency: actor.agency },
    createdById: actor.userId,
  };
  for (const [i, item] of p.issues.entries()) {
    const edges = (item.blockedBy ?? []).map((k) => ({
      kind: 'blocks' as const,
      dependsOnId: (typeof k === 'number' ? ids[k] : blockers.get(k)) as string,
      reason: `breakdown of ${requirementKey(req.reqSeq)} (suggestion ${row.id})`,
    }));
    await writeIssueRelations(writer, projectId, ids[i] as string, edges, tx);
  }
  const prefix = await activeIssuePrefix(projectId);
  return {
    refusals: null,
    effect: {
      requirementId: req.id,
      requirement: requirementKey(req.reqSeq),
      revision: head,
      issues: filed.map((f) => ({
        ...f,
        key: formatIssueRef(prefix, seqOf.get(f.issueId) ?? 0),
      })),
    },
  };
}
