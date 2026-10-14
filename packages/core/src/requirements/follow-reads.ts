/**
 * What an approved design changed of the requirements pinned behind it (REQ-41 BC-10, Requirement
 * lifecycle `agreed`). Nothing here moves a pin: a requirement whose latest baseline pins a design
 * behind its approved revision waits on a signer to update it (`repin.ts:repinIn`, the "Update to the
 * approved design" act, gated by `approvals`), or, where the approval removed or renamed a step (or
 * removed an edge) a live criterion traces, on the assistant to revise those criteria
 * (`standing.ts`, the stale-pin turn). The standing reads both from here.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { requirementCriteria, requirementCriterionSteps } from '../db/schema-requirements.js';
import { projectWorkflowDesigns, projectWorkflows } from '../db/schema-workflows.js';
import type { TracedChange } from './standing-follow.js';

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
