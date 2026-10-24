/**
 * Pin-only changes and the one act that approves them: a revision that differs from its design's
 * approved revision only in the base revisions it pins is read on the canonical design, never on its
 * text, and the act that clears a moved base's dependents is planned here, every base before what
 * builds on it, so `WORKFLOW_DESIGN_BASE_UNAPPROVED` holds at each approval in the act; designs whose
 * bases name each other in a ring are one unit of that order, re-pinned and approved together.
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
  /**
   * The designs of the ring this one is re-pinned with, itself included, in the plan's order; empty
   * where it names no design that names it back. A ring is written whole, then approved whole.
   */
  ring: readonly string[];
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

function ringHeldRefusal(
  d: RepinDesign,
  ring: readonly string[],
  held: readonly string[],
): DesignRefusal {
  const names = (flows: readonly string[]) => flows.map((f) => `"${f}"`).join(', ');
  return {
    code: 'WORKFLOW_REPIN_RING_HELD',
    path: '',
    flow: d.flow,
    detail: `"${d.flow}" is re-pinned only together with ${names(ring.filter((f) => f !== d.flow))}, whose bases name each other in a ring, and this act cannot take ${names(held)}; a ring re-pins whole or not at all. Nothing was written.`,
  };
}

/** The flows each member pins among `members`: the edges a re-pin orders bases before. */
const pinsAmong = (d: RepinDesign, members: ReadonlySet<string>) =>
  (d.approved?.basedOn ?? []).map((p) => p.workflow).filter((w) => members.has(w));

/** The rings among `members`: each set of designs that reach each other through their pins. */
function ringsOf(members: ReadonlySet<string>, byFlow: ReadonlyMap<string, RepinDesign>) {
  const reach = new Map<string, Set<string>>();
  for (const f of members) {
    const seen = new Set<string>();
    const walk = [f];
    while (walk.length > 0) {
      for (const next of pinsAmong(byFlow.get(walk.pop() as string) as RepinDesign, members)) {
        if (!seen.has(next)) {
          seen.add(next);
          walk.push(next);
        }
      }
    }
    reach.set(f, seen);
  }
  const unitOf = new Map<string, string[]>();
  for (const f of [...members].sort()) {
    if (unitOf.has(f)) continue;
    const unit = [...members]
      .filter((g) => g === f || (reach.get(f)?.has(g) && reach.get(g)?.has(f)))
      .sort();
    for (const g of unit) unitOf.set(g, unit);
  }
  return unitOf;
}

/**
 * The designs that take part in a re-pin of `base`, as units ordered every base unit first: a unit
 * is one design, or a ring of designs whose bases name each other, which no order can split.
 */
function orderedUnits(
  base: string,
  byFlow: ReadonlyMap<string, RepinDesign>,
  baseAt: number,
  include: ReadonlySet<string> | null,
): RepinDesign[][] {
  const members = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of byFlow.values()) {
      if (d.flow === base || members.has(d.flow) || d.approvedRevision === null) continue;
      if (include && !include.has(d.id)) continue;
      const moved = (d.approved?.basedOn ?? []).some(
        (p) => (p.workflow === base && p.revision !== baseAt) || members.has(p.workflow),
      );
      if (moved) {
        members.add(d.flow);
        grew = true;
      }
    }
  }
  const unitOf = ringsOf(members, byFlow);
  const units: RepinDesign[][] = [];
  const placed = new Set<string>();
  let left = [...new Set(unitOf.values())].sort((a, b) =>
    (a[0] as string).localeCompare(b[0] as string),
  );
  while (left.length > 0) {
    const next = left.filter((unit) =>
      unit.every((f) =>
        pinsAmong(byFlow.get(f) as RepinDesign, members).every(
          (p) => unit.includes(p) || placed.has(p),
        ),
      ),
    );
    // the units of rings form no ring among themselves, so some unit is always free to place
    if (next.length === 0) throw new Error(`workflows: re-pin units of ${base} form a ring`);
    for (const unit of next) {
      for (const f of unit) placed.add(f);
      units.push(unit.map((f) => byFlow.get(f) as RepinDesign));
    }
    left = left.filter((unit) => !next.includes(unit));
  }
  return units;
}

type Planned =
  | { kind: 'none' }
  | { kind: 'refused'; refusal: DesignRefusal }
  | { kind: 'ready'; step: RepinStep };

/**
 * One design re-pinned onto the revisions `approvedAt` holds for its bases, or why the act cannot
 * take it. `fileAllowed` false writes a re-pin even over a filed pin-only proposal.
 */
function planOne(
  d: RepinDesign,
  base: string,
  designs: readonly RepinDesign[],
  approvedAt: ReadonlyMap<string, number | null>,
  ring: readonly string[],
  fileAllowed = true,
): Planned {
  const approved = d.approved as WorkflowWrite;
  const pins = approved.basedOn ?? [];
  const targets = pins.map((p) => ({
    workflow: p.workflow,
    revision: approvedAt.get(p.workflow) ?? null,
  }));
  if (targets.every((t, i) => t.revision === pins[i]?.revision)) return { kind: 'none' };
  const pending = d.pending?.document ?? null;
  const filed = pending ? pinOnlyChange(approved, pending, d.template) : null;
  if (d.designStatus === 'returned' || d.designStatus === 'draft' || (d.pending && !filed)) {
    return { kind: 'refused', refusal: pendingChangeRefusal(d, base) };
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
        revision: x.revision,
        designStatus: x.designStatus,
        approvedRevision: approvedAt.get(x.flow) ?? null,
      })),
    ),
  );
  if (unapproved) return { kind: 'refused', refusal: { ...unapproved, flow: d.flow } };
  const pinned = targets.map((t) => ({ workflow: t.workflow, revision: t.revision as number }));
  const asFiled =
    fileAllowed &&
    d.pending &&
    pending &&
    filed &&
    canonicalJson(pending.basedOn) === canonicalJson(pinned);
  const write = asFiled ? null : { ...(d.current ?? approved), basedOn: pinned };
  const change = asFiled ? filed : write ? pinOnlyChange(approved, write, d.template) : null;
  if (!change) return { kind: 'refused', refusal: pendingChangeRefusal(d, base) };
  return {
    kind: 'ready',
    step: {
      design: d,
      source: asFiled ? 'proposal' : 'approved',
      approves: asFiled ? (d.pending?.revision as number) : d.revision + 1,
      write,
      change,
      ring,
    },
  };
}

/**
 * A ring planned as one unit (FB-150): each member's next approved revision is fixed first, every
 * pin inside the ring moves to the revision the act approves for that member, and the base check
 * reads the ring approved together. A filed pin-only proposal is approved as filed only where its
 * pins are the ones the ring lands on; where the members' choices never settle, each is written.
 * Any member the act cannot take holds the whole ring, each other member refused naming it.
 */
function planRing(
  unit: readonly RepinDesign[],
  base: string,
  designs: readonly RepinDesign[],
  approvedAt: Map<string, number | null>,
): { ready: RepinStep[]; refused: RepinPlanOf['refused'] } {
  const ring = unit.map((d) => d.flow);
  const before = new Map(ring.map((f) => [f, approvedAt.get(f) ?? null]));
  const plan = (fileAllowed: boolean) =>
    unit.map((d) => planOne(d, base, designs, approvedAt, ring, fileAllowed));
  let guess = new Map(unit.map((d) => [d.flow, d.revision + 1]));
  let planned: Planned[] = [];
  let settled = false;
  for (let round = 0; round <= unit.length && !settled; round += 1) {
    for (const [f, r] of guess) approvedAt.set(f, r);
    planned = plan(true);
    const next = new Map(
      unit.map((d, i) => {
        const p = planned[i] as Planned;
        return [d.flow, p.kind === 'ready' ? p.step.approves : d.revision + 1];
      }),
    );
    settled =
      planned.some((p) => p.kind !== 'ready') || ring.every((f) => next.get(f) === guess.get(f));
    guess = next;
  }
  if (!settled) {
    for (const d of unit) approvedAt.set(d.flow, d.revision + 1);
    planned = plan(false);
  }
  const held = unit.filter((_, i) => planned[i]?.kind === 'refused').map((d) => d.flow);
  if (held.length > 0) {
    for (const [f, r] of before) approvedAt.set(f, r);
    return {
      ready: [],
      refused: unit.map((d, i) => {
        const p = planned[i] as Planned;
        return {
          design: d,
          refusal: p.kind === 'refused' ? p.refusal : ringHeldRefusal(d, ring, held),
        };
      }),
    };
  }
  return {
    ready: planned.flatMap((p) => (p.kind === 'ready' ? [p.step] : [])),
    refused: [],
  };
}

/**
 * The act that approves `base`'s pin-only dependents: every design whose approved revision pins
 * `base` at another revision than the approved one, and every design resting on one of those, each
 * re-pinned to the revision its bases stand approved at once the designs before it are; designs
 * whose bases name each other in a ring are re-pinned together (`planRing`). A pin-only proposal
 * already filed at those revisions is approved as filed; any other pending change, or a base with no
 * approved revision, refuses that design by name. `include` narrows the act to the designs named;
 * null plans every one.
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
  const out: RepinPlanOf = { ready: [], refused: [] };
  for (const unit of orderedUnits(base, byFlow, baseAt, include)) {
    if (unit.length > 1) {
      const ring = planRing(unit, base, designs, approvedAt);
      out.ready.push(...ring.ready);
      out.refused.push(...ring.refused);
      continue;
    }
    const d = unit[0] as RepinDesign;
    const planned = planOne(d, base, designs, approvedAt, []);
    if (planned.kind === 'refused') out.refused.push({ design: d, refusal: planned.refusal });
    if (planned.kind !== 'ready') continue;
    approvedAt.set(d.flow, planned.step.approves);
    out.ready.push(planned.step);
  }
  return out;
}
