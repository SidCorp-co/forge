/**
 * Pin-only changes and the one act that approves them: a revision that differs from its design's
 * approved revision only in the base revisions it pins is read on the canonical design, never on its
 * text, and the act that clears a moved base's dependents is planned here, every base before what
 * builds on it, so `WORKFLOW_DESIGN_BASE_UNAPPROVED` holds at each approval in the act.
 */

import type { DesignStatus } from '@forge/contracts/design-status';
import type { WorkflowTemplate } from '@forge/contracts/workflow-templates';
import type { PinMove, PinOnlyChange, RepinSource } from '@forge/contracts/workflows';
import { jsonPointer as pointer } from '../lib/refusal.js';
import {
  canonicalJson,
  type DesignRefusal,
  designFingerprint,
  fingerprintShape,
} from './design.js';
import { baseApprovalRefusal, readBases } from './design-bases.js';
import type { WorkflowWrite } from './schema.js';

/** Every path at which two canonical values differ: object keys by name, arrays by position. */
export function canonicalDiff(a: unknown, b: unknown, path: (string | number)[] = []): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => canonicalDiff(x, b[i], [...path, i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set(
      [...Object.keys(a), ...Object.keys(b)].filter(
        (k) => a[k] !== undefined || b[k] !== undefined,
      ),
    );
    return [...keys].sort().flatMap((k) => canonicalDiff(a[k], b[k], [...path, k]));
  }
  return canonicalJson(a ?? null) === canonicalJson(b ?? null) ? [] : [pointer(path)];
}

const PIN_PATH = /^\/basedOn\/(\d+)\/revision$/;

/**
 * `proposed` against `approved` when the only change is the revisions its bases are pinned at, else
 * null: an identical design, a base added, removed or reordered, or any other change is not one.
 */
export function pinOnlyChange(
  approved: WorkflowWrite,
  proposed: WorkflowWrite,
  template: WorkflowTemplate | null,
): PinOnlyChange | null {
  const changed = canonicalDiff(
    fingerprintShape(approved, template),
    fingerprintShape(proposed, template),
  );
  if (changed.length === 0) return null;
  const pins: PinMove[] = [];
  for (const path of changed) {
    const at = PIN_PATH.exec(path);
    const was = at ? approved.basedOn?.[Number(at[1])] : undefined;
    const now = at ? proposed.basedOn?.[Number(at[1])] : undefined;
    if (!was || !now) return null;
    pins.push({ workflow: was.workflow, from: was.revision, to: now.revision });
  }
  const unpinned = { ...proposed, ...(approved.basedOn ? { basedOn: approved.basedOn } : {}) };
  return { pins, changed, fingerprint: designFingerprint(unpinned, template) };
}

/** What the plan reads of one design of the project. */
export interface RepinDesign {
  id: string;
  flow: string;
  revision: number;
  designStatus: DesignStatus | null;
  approvedRevision: number | null;
  /** The workflow's current document. */
  current: WorkflowWrite | null;
  /** Its approved revision's document. */
  approved: WorkflowWrite | null;
  /** Its newest revision put to the approver, where that one is undecided. */
  pending: { revision: number; document: WorkflowWrite | null; proposedBy: string } | null;
  template: WorkflowTemplate | null;
}

export interface RepinStep {
  design: RepinDesign;
  source: RepinSource;
  /** The revision the act leaves approved. */
  approves: number;
  /** The document the act writes; null where it approves a filed proposal as it stands. */
  write: WorkflowWrite | null;
  change: PinOnlyChange;
}

export interface RepinPlanOf {
  ready: RepinStep[];
  refused: { design: RepinDesign; refusal: DesignRefusal }[];
}

function pendingChangeRefusal(d: RepinDesign, base: string): DesignRefusal {
  const what =
    d.designStatus === 'returned'
      ? `its revision ${d.pending?.revision ?? d.revision} was returned and is owed a revision`
      : `revision ${d.pending?.revision ?? d.revision} waits on its approver with a change beyond the base revisions it pins`;
  return {
    code: 'WORKFLOW_REPIN_PENDING_CHANGE',
    path: '',
    flow: d.flow,
    detail: `"${d.flow}" rests on "${base}" at an older revision, and ${what}; a re-pin would bury that change, so it goes through its own review. Decide it on its own page; nothing was written.`,
  };
}

function cycleRefusal(d: RepinDesign): DesignRefusal {
  return {
    code: 'WORKFLOW_REPIN_CYCLE',
    path: '',
    flow: d.flow,
    detail: `"${d.flow}" is among designs whose bases name each other in a ring, so no order approves every base before what builds on it; re-pin it by writing it again. Nothing was written.`,
  };
}

/** The designs that take part in a re-pin of `base`, ordered every base first; null for a ring. */
function orderedMembers(
  base: string,
  byFlow: ReadonlyMap<string, RepinDesign>,
  baseAt: number,
  include: ReadonlySet<string> | null,
): { order: RepinDesign[]; ring: RepinDesign[] } {
  const pinsOf = (d: RepinDesign) => d.approved?.basedOn ?? [];
  const members = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of byFlow.values()) {
      if (d.flow === base || members.has(d.flow) || d.approvedRevision === null) continue;
      if (include && !include.has(d.id)) continue;
      const moved = pinsOf(d).some(
        (p) => (p.workflow === base && p.revision !== baseAt) || members.has(p.workflow),
      );
      if (moved) {
        members.add(d.flow);
        grew = true;
      }
    }
  }
  const order: RepinDesign[] = [];
  const placed = new Set<string>();
  let left = [...members].sort();
  while (left.length > 0) {
    const next = left.filter((f) =>
      pinsOf(byFlow.get(f) as RepinDesign).every(
        (p) => !members.has(p.workflow) || placed.has(p.workflow),
      ),
    );
    if (next.length === 0) break;
    for (const f of next) {
      placed.add(f);
      order.push(byFlow.get(f) as RepinDesign);
    }
    left = left.filter((f) => !placed.has(f));
  }
  return { order, ring: left.map((f) => byFlow.get(f) as RepinDesign) };
}

/**
 * The act that approves `base`'s pin-only dependents: every design whose approved revision pins
 * `base` at another revision than the approved one, and every design resting on one of those, each
 * re-pinned to the revision its bases stand approved at once the designs before it are. A pin-only
 * proposal already filed at those revisions is approved as filed; any other pending change, or a
 * base with no approved revision, refuses that design by name. `include` narrows the act to the
 * designs named; null plans every one.
 */
export function planRepins(
  base: string,
  designs: readonly RepinDesign[],
  include: ReadonlySet<string> | null = null,
): RepinPlanOf {
  const byFlow = new Map(designs.map((d) => [d.flow, d]));
  const baseAt = byFlow.get(base)?.approvedRevision ?? null;
  if (baseAt === null) return { ready: [], refused: [] };
  const approvedAt = new Map(designs.map((d) => [d.flow, d.approvedRevision]));
  const { order, ring } = orderedMembers(base, byFlow, baseAt, include);
  const out: RepinPlanOf = {
    ready: [],
    refused: ring.map((d) => ({ design: d, refusal: cycleRefusal(d) })),
  };
  for (const d of order) {
    const approved = d.approved as WorkflowWrite;
    const pins = approved.basedOn ?? [];
    const targets = pins.map((p) => ({
      workflow: p.workflow,
      revision: approvedAt.get(p.workflow) ?? null,
    }));
    if (targets.every((t, i) => t.revision === pins[i]?.revision)) continue;
    const pending = d.pending?.document ?? null;
    const filed = pending ? pinOnlyChange(approved, pending, d.template) : null;
    if (d.designStatus === 'returned' || d.designStatus === 'draft' || (d.pending && !filed)) {
      out.refused.push({ design: d, refusal: pendingChangeRefusal(d, base) });
      continue;
    }
    const unapproved = baseApprovalRefusal(
      d.pending?.revision ?? d.revision + 1,
      readBases(
        targets.map((t, i) => ({
          workflow: t.workflow,
          revision: t.revision ?? (pins[i] as { revision: number }).revision,
        })),
        designs.map((x) => ({
          flow: x.flow,
          designStatus: x.designStatus,
          approvedRevision: approvedAt.get(x.flow) ?? null,
        })),
      ),
    );
    if (unapproved) {
      out.refused.push({ design: d, refusal: { ...unapproved, flow: d.flow } });
      continue;
    }
    const pinned = targets.map((t) => ({ workflow: t.workflow, revision: t.revision as number }));
    const asFiled =
      d.pending && pending && filed && canonicalJson(pending.basedOn) === canonicalJson(pinned);
    const write = asFiled ? null : { ...(d.current ?? approved), basedOn: pinned };
    const change = asFiled ? filed : write ? pinOnlyChange(approved, write, d.template) : null;
    if (!change) {
      out.refused.push({ design: d, refusal: pendingChangeRefusal(d, base) });
      continue;
    }
    const approves = asFiled ? (d.pending?.revision as number) : d.revision + 1;
    approvedAt.set(d.flow, approves);
    out.ready.push({
      design: d,
      source: asFiled ? 'proposal' : 'approved',
      approves,
      write,
      change,
    });
  }
  return out;
}
