/**
 * A requirement follows an approved design by itself when its criteria do not change (REQ-41 BC-10;
 * Requirement lifecycle `agreed`). On a workflow design reaching `approved`, every agreed requirement
 * whose latest baseline pins an older revision of it is re-pinned by the kernel through
 * `repin.ts:repinIn`, the act a person's "Update to the approved design" takes, with a reason naming
 * both revisions. Where the newer revision removed or renamed a step (or removed an edge) a live
 * criterion traces, nothing is re-pinned: the requirement waits on the assistant to revise those
 * criteria (`standing.ts`, the stale-pin turn). A contract that moved too is left to a person, as
 * before: a contract version is not a design. The same follow runs on a timer for the rows stale
 * before this rule, and for a delivery that was lost.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import {
  requirementCriteria,
  requirementCriterionSteps,
  requirements,
} from '../db/schema-requirements.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { linkedContracts } from './baselines.js';
import { repinIn } from './repin.js';
import { staleContractPinsOf } from './rules.js';
import type { TracedChange } from './standing-follow.js';
import { inTx, lockRequirements } from './write-tx.js';

/** The nodes of one design revision a trace can name: each step's id and the name it shows, each edge. */
export interface DesignNodes {
  steps: ReadonlyMap<string, string | null>;
  edges: readonly { from: string; to: string; label: string | null }[];
}

/** What one live criterion traces on one design. */
export interface CriterionTrace {
  code: string;
  steps: readonly string[];
  edges: readonly { from: string; to: string; label: string | null }[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** A stored design document read only for its node ids and names; null where it holds no steps. */
export function nodesOfDesign(document: unknown): DesignNodes | null {
  const doc = document as { steps?: unknown; edges?: unknown } | null;
  if (!doc || !Array.isArray(doc.steps)) return null;
  const steps = new Map<string, string | null>();
  for (const s of doc.steps as { id?: unknown; title?: unknown; node?: { label?: unknown } }[]) {
    const id = text(s?.id);
    if (id) steps.set(id, text(s.node?.label) ?? text(s.title));
  }
  const edges = Array.isArray(doc.edges)
    ? (doc.edges as { from?: unknown; to?: unknown; label?: unknown }[]).flatMap((e) => {
        const from = text(e?.from);
        const to = text(e?.to);
        return from && to ? [{ from, to, label: text(e.label) }] : [];
      })
    : [];
  return { steps, edges };
}

/**
 * Each node a live criterion traces that `approved` removed or renamed against `pinned`: a traced
 * step absent from `approved` is removed, one whose shown name differs is renamed, a traced edge
 * with no edge of the same ends (and label, where the trace names one) is removed. With no pinned
 * revision to compare (none pinned, or its document unreadable), only a removal can be read.
 */
export function tracedStepChanges(
  traces: readonly CriterionTrace[],
  pinned: DesignNodes | null,
  approved: DesignNodes,
): { code: string; node: string; change: 'removed' | 'renamed' }[] {
  const out: { code: string; node: string; change: 'removed' | 'renamed' }[] = [];
  for (const t of traces) {
    for (const step of t.steps) {
      if (!approved.steps.has(step)) out.push({ code: t.code, node: step, change: 'removed' });
      else if (pinned?.steps.has(step) && pinned.steps.get(step) !== approved.steps.get(step)) {
        out.push({ code: t.code, node: step, change: 'renamed' });
      }
    }
    for (const e of t.edges) {
      const held = approved.edges.some(
        (x) => x.from === e.from && x.to === e.to && (e.label === null || x.label === e.label),
      );
      if (!held) out.push({ code: t.code, node: `${e.from}>${e.to}`, change: 'removed' });
    }
  }
  return out;
}

interface StaleDesignPin {
  requirementId: string;
  workflowId: string;
  flow: string;
  title: string;
  pinned: number | null;
  approved: number;
}

/** Each linked design the latest baseline of each requirement pins below its approved revision, or not at all. */
async function staleDesignPinsOf(
  executor: Tx | typeof db,
  ids: readonly string[],
): Promise<StaleDesignPin[]> {
  if (ids.length === 0) return [];
  const rows = rowsOf<{
    requirement_id: string;
    workflow_id: string;
    flow: string;
    title: string | null;
    pinned: number | null;
    approved: number;
  }>(
    await executor.execute(sql`
      SELECT rw.requirement_id, w.id AS workflow_id, w.flow, w.document->>'title' AS title,
             p.design_revision AS pinned, w.approved_revision AS approved
        FROM requirement_workflows rw
        JOIN project_workflows w ON w.id = rw.workflow_id
        JOIN LATERAL (
               SELECT b.revision, b.seq FROM requirement_baselines b
                WHERE b.requirement_id = rw.requirement_id
                ORDER BY b.revision DESC, b.seq DESC LIMIT 1) lb ON true
        LEFT JOIN requirement_baseline_pins p
          ON p.requirement_id = rw.requirement_id AND p.workflow_id = rw.workflow_id
         AND p.revision = lb.revision AND p.baseline_seq = lb.seq
       WHERE rw.requirement_id IN (${idList(ids)})
         AND w.approved_revision IS NOT NULL
         AND (p.design_revision IS NULL OR p.design_revision < w.approved_revision)`),
  );
  return rows.map((r) => ({
    requirementId: r.requirement_id,
    workflowId: r.workflow_id,
    flow: r.flow,
    title: r.title ?? r.flow,
    pinned: r.pinned === null ? null : Number(r.pinned),
    approved: Number(r.approved),
  }));
}

/** The nodes of each `(workflow, revision)` asked for, from its stored design revision or, for the head, the workflow itself. */
async function designNodesAt(
  executor: Tx | typeof db,
  wanted: readonly { workflowId: string; revision: number }[],
): Promise<Map<string, DesignNodes>> {
  const out = new Map<string, DesignNodes>();
  if (wanted.length === 0) return out;
  const workflowIds = [...new Set(wanted.map((w) => w.workflowId))];
  const stored = await executor
    .select({
      workflowId: projectWorkflowDesigns.workflowId,
      revision: projectWorkflowDesigns.revision,
      document: projectWorkflowDesigns.document,
    })
    .from(projectWorkflowDesigns)
    .where(inArray(projectWorkflowDesigns.workflowId, workflowIds));
  const heads = await executor
    .select({
      workflowId: projectWorkflows.id,
      revision: projectWorkflows.revision,
      document: projectWorkflows.document,
    })
    .from(projectWorkflows)
    .where(inArray(projectWorkflows.id, workflowIds));
  for (const row of [...heads, ...stored]) {
    const nodes = nodesOfDesign(row.document);
    if (nodes) out.set(`${row.workflowId}@${row.revision}`, nodes);
  }
  return out;
}

/** What each live criterion of each requirement traces, per design. */
async function liveTracesOf(
  executor: Tx | typeof db,
  ids: readonly string[],
): Promise<Map<string, CriterionTrace[]>> {
  const out = new Map<string, CriterionTrace[]>();
  if (ids.length === 0) return out;
  const rows = await executor
    .select({
      requirementId: requirementCriterionSteps.requirementId,
      workflowId: requirementCriterionSteps.workflowId,
      code: requirementCriterionSteps.code,
      stepId: requirementCriterionSteps.stepId,
      edgeFrom: requirementCriterionSteps.edgeFrom,
      edgeTo: requirementCriterionSteps.edgeTo,
      edgeLabel: requirementCriterionSteps.edgeLabel,
    })
    .from(requirementCriterionSteps)
    .innerJoin(
      requirementCriteria,
      and(
        eq(requirementCriteria.requirementId, requirementCriterionSteps.requirementId),
        eq(requirementCriteria.code, requirementCriterionSteps.code),
        isNull(requirementCriteria.retiredRevision),
      ),
    )
    .where(inArray(requirementCriterionSteps.requirementId, [...ids]));
  const by = new Map<
    string,
    { code: string; steps: string[]; edges: CriterionTrace['edges'][number][] }
  >();
  for (const r of rows) {
    const key = `${r.requirementId}|${r.workflowId}|${r.code}`;
    const t = by.get(key) ?? { code: r.code, steps: [], edges: [] };
    if (r.stepId) t.steps.push(r.stepId);
    else if (r.edgeFrom && r.edgeTo)
      t.edges.push({ from: r.edgeFrom, to: r.edgeTo, label: r.edgeLabel });
    by.set(key, t);
  }
  for (const [key, t] of by) {
    const [requirementId, workflowId] = key.split('|');
    const k = `${requirementId}|${workflowId}`;
    out.set(k, [...(out.get(k) ?? []), t]);
  }
  return out;
}

/** One stale design pin with what its approval changed of the requirement's traces; `unread` where a revision's document could not be read. */
export interface StaleDesignFollow extends StaleDesignPin {
  changes: TracedChange[];
  unread: boolean;
}

/** Per requirement, each linked design pinned behind its approval and the traced nodes that approval removed or renamed. */
export async function followReadsOf(
  executor: Tx | typeof db,
  ids: readonly string[],
): Promise<Map<string, StaleDesignFollow[]>> {
  const out = new Map<string, StaleDesignFollow[]>();
  const stale = await staleDesignPinsOf(executor, ids);
  if (stale.length === 0) return out;
  const requirementIds = [...new Set(stale.map((s) => s.requirementId))];
  const [nodes, traces] = await Promise.all([
    designNodesAt(
      executor,
      stale.flatMap((s) => [
        { workflowId: s.workflowId, revision: s.approved },
        ...(s.pinned === null ? [] : [{ workflowId: s.workflowId, revision: s.pinned }]),
      ]),
    ),
    liveTracesOf(executor, requirementIds),
  ]);
  for (const s of stale) {
    const approved = nodes.get(`${s.workflowId}@${s.approved}`);
    const pinned = s.pinned === null ? null : (nodes.get(`${s.workflowId}@${s.pinned}`) ?? null);
    const mine = traces.get(`${s.requirementId}|${s.workflowId}`) ?? [];
    const changes = approved
      ? tracedStepChanges(mine, pinned, approved).map((c) => ({
          ...c,
          flow: s.flow,
          title: s.title,
          approved: s.approved,
        }))
      : [];
    out.set(s.requirementId, [
      ...(out.get(s.requirementId) ?? []),
      { ...s, changes, unread: !approved },
    ]);
  }
  return out;
}

export type FollowOutcome =
  | 'followed'
  | 'current'
  | 'traced_step_changed'
  | 'contract_moved'
  | 'design_unread'
  | 'no_approver'
  | 'refused';

/** Who the follow is recorded as: whoever approved the newest of the designs it follows. */
async function approverOf(tx: Tx, pins: readonly StaleDesignPin[]): Promise<string | null> {
  for (const p of [...pins].sort((a, b) => b.approved - a.approved)) {
    const [row] = await tx
      .select({ by: projectWorkflowDesigns.decidedByUser })
      .from(projectWorkflowDesigns)
      .where(
        and(
          eq(projectWorkflowDesigns.workflowId, p.workflowId),
          eq(projectWorkflowDesigns.revision, p.approved),
        ),
      );
    if (row?.by) return row.by;
  }
  return null;
}

const pinWords = (pins: readonly StaleDesignPin[]) =>
  pins.map((p) => `${p.flow} r${p.pinned ?? 'none'} → r${p.approved}`).join(', ');

/** The kernel's follow of one agreed requirement, in one transaction under the project's requirement lock. */
export async function followRequirement(
  projectId: string,
  requirementId: string,
): Promise<FollowOutcome> {
  let outcome: FollowOutcome = 'current';
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const [row] = await tx
      .select({ status: requirements.status, head: requirements.currentRevision })
      .from(requirements)
      .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, projectId)));
    if (row?.status !== 'agreed' || row.head === null) return null;
    const stale = (await followReadsOf(tx, [requirementId])).get(requirementId) ?? [];
    if (stale.length === 0) return null;
    if (stale.some((s) => s.unread)) {
      outcome = 'design_unread';
      return null;
    }
    if (stale.some((s) => s.changes.length > 0)) {
      outcome = 'traced_step_changed';
      return null;
    }
    const contracts = await linkedContracts(tx, requirementId);
    const contractPins = rowsOf<{
      provider_project_id: string;
      contract_slug: string;
      contract_version: string;
    }>(
      await tx.execute(sql`
        SELECT p.provider_project_id, p.contract_slug, p.contract_version
          FROM requirement_baseline_pins p
         WHERE p.requirement_id = ${requirementId} AND p.contract_slug IS NOT NULL
           AND (p.revision, p.baseline_seq) = (
                 SELECT b.revision, b.seq FROM requirement_baselines b
                  WHERE b.requirement_id = ${requirementId}
                  ORDER BY b.revision DESC, b.seq DESC LIMIT 1)`),
    ).map((p) => ({
      providerProjectId: p.provider_project_id,
      contractSlug: p.contract_slug,
      contractVersion: p.contract_version,
    }));
    if (staleContractPinsOf(contracts, contractPins).length > 0) {
      outcome = 'contract_moved';
      return null;
    }
    const by = await approverOf(tx, stale);
    if (!by) {
      outcome = 'no_approver';
      return null;
    }
    const refused = await repinIn(tx, {
      projectId,
      requirementId,
      revision: row.head,
      by,
      reason: `Followed by itself on the design approval: ${pinWords(stale)}. No step a current criterion traces was removed or renamed, so no criterion changes (REQ-41 BC-10).`,
    });
    outcome = refused?.length ? 'refused' : 'followed';
    return refused;
  });
  if (refusals?.length) {
    logger.warn(
      { projectId, requirementId, refusals },
      'requirement-follow: the kernel re-pin was refused; the requirement waits on a person to update it',
    );
  }
  return outcome;
}

/** Every agreed requirement of `projectId` linking `workflowId`, followed. */
export async function followApprovedDesign(
  projectId: string,
  workflowId: string,
): Promise<Record<string, FollowOutcome>> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT r.id FROM requirements r
        JOIN requirement_workflows rw ON rw.requirement_id = r.id
       WHERE r.project_id = ${projectId} AND rw.workflow_id = ${workflowId} AND r.status = 'agreed'
       ORDER BY r.req_seq`),
  );
  const out: Record<string, FollowOutcome> = {};
  for (const r of rows) out[r.id] = await followRequirement(projectId, r.id);
  return out;
}

/** The timer's pass: every agreed requirement on any project pinning a design behind its approval. */
export async function followApprovedDesigns(): Promise<{ followed: number; left: number }> {
  const rows = rowsOf<{ id: string; project_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT r.id, r.project_id, r.req_seq FROM requirements r
        JOIN requirement_workflows rw ON rw.requirement_id = r.id
        JOIN project_workflows w ON w.id = rw.workflow_id
        JOIN LATERAL (
               SELECT b.revision, b.seq FROM requirement_baselines b
                WHERE b.requirement_id = r.id
                ORDER BY b.revision DESC, b.seq DESC LIMIT 1) lb ON true
        LEFT JOIN requirement_baseline_pins p
          ON p.requirement_id = r.id AND p.workflow_id = rw.workflow_id
         AND p.revision = lb.revision AND p.baseline_seq = lb.seq
       WHERE r.status = 'agreed' AND w.approved_revision IS NOT NULL
         AND (p.design_revision IS NULL OR p.design_revision < w.approved_revision)
       ORDER BY r.project_id, r.req_seq`),
  );
  let followed = 0;
  for (const r of rows) {
    if ((await followRequirement(r.project_id, r.id)) === 'followed') followed += 1;
  }
  return { followed, left: rows.length - followed };
}

/** The approve of a design is the follow's trigger; a return moves no pin. */
export function registerRequirementFollow(): void {
  consume('workflow.designDecided', {
    name: 'requirement-follow',
    handle: async (p) => {
      if (p.decision !== 'approve') return;
      const outcomes = await followApprovedDesign(p.projectId, p.workflowId);
      const followed = Object.values(outcomes).filter((o) => o === 'followed').length;
      if (Object.keys(outcomes).length > 0) {
        logger.info(
          { projectId: p.projectId, workflowId: p.workflowId, followed, outcomes },
          'requirement-follow: agreed requirements read against the approved design',
        );
      }
    },
  });
}
