import {
  type DesignDiffView,
  emptyHealthCounts,
  HEALTH_MARKER_KINDS,
  type HealthMarker,
  type HealthMarkerKind,
  type HealthNode,
  type HealthNodeDecision,
  type MarkerAspect,
  type NodePhase,
  type RewriteRule,
  type WorkflowHealth,
  type WorkflowReconciliation,
} from '@forge/contracts/workflow-health';
import { type DesignDiff, designDiff, edgeKey } from './design-diff.js';
import {
  approvedDocumentOf,
  decisionTarget,
  type HealthFacts,
  Markers,
  masterOwes,
  type NodeTarget,
  OPEN_ISSUE,
  PROVENANCE,
  personDecides,
  targetKey,
  waitsOnPerson,
} from './health-facts.js';
import {
  needsUpdateMarkers,
  orphansOf,
  outdatedMarkers,
  problemMarkers,
  provenanceOf,
  removeMarkers,
} from './health-markers.js';
import { matchLayers } from './health-match.js';
import type { WorkflowWrite } from './schema.js';

function diffView(
  diff: DesignDiff | null,
  from: number | null,
  to: number | null,
): DesignDiffView | null {
  if (!diff || from === null || to === null) return null;
  return {
    from,
    to,
    steps: Object.fromEntries(diff.steps),
    edges: Object.fromEntries(diff.edges),
  };
}

/** The steps a node reads as built by: a planned target its planned steps, an observed one its observed steps. */
function buildNames(b: HealthFacts['builds'][number], target: NodeTarget): boolean {
  const steps = target.kind === 'step' ? [target.step] : [target.from, target.to];
  const named =
    target.layer === 'planned'
      ? b.targets.flatMap((t) => (t.kind === 'step' ? [t.step] : []))
      : b.observedSteps;
  return named.some((s) => steps.includes(s));
}

type Decision = HealthFacts['decisions'][number];

/** The builds naming the node that were linked after its decision: the issues that carry it to reconciled. */
const buildsAfter = (f: HealthFacts, target: NodeTarget, decision: Decision) =>
  f.builds.filter((b) => b.linkedAt > decision.at && buildNames(b, target));

/** Whether the observation matches the node to a step or line of `doc` with no divergence. */
function observedMatching(
  doc: WorkflowWrite,
  obs: NonNullable<HealthFacts['observation']>,
  target: NodeTarget,
): boolean {
  const match = matchLayers(doc, obs.document);
  const plannedOf = (id: string) =>
    target.layer === 'planned'
      ? id
      : [...match.steps].find(([, pair]) => pair.observed === id)?.[0];
  if (target.kind === 'step') {
    const id = plannedOf(target.step);
    return id !== undefined && match.steps.get(id)?.aspects.length === 0;
  }
  const from = plannedOf(target.from);
  const to = plannedOf(target.to);
  return from !== undefined && to !== undefined && match.edges.get(edgeKey(from, to))?.length === 0;
}

/**
 * A keep with no build after it is settled by the first revision approved after the decision that
 * adopts the code; it is reconciled by an observation taken after that approval, just as a build is
 * by one taken after its close. Null when no such revision exists yet.
 */
function adoptionOf(f: HealthFacts, target: NodeTarget, decision: Decision): Date | null {
  if (decision.node.verdict !== 'keep') return null;
  const obs = f.observation;
  const approved = f.revisions
    .filter(
      (r): r is typeof r & { document: WorkflowWrite; decidedAt: Date } =>
        r.document !== null && r.decidedAt !== null && r.decidedAt > decision.at,
    )
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  const adopting = approved.find((r) => {
    if (target.layer === 'planned') {
      return target.kind === 'step'
        ? r.document.steps.some((s) => s.id === target.step)
        : (r.document.edges ?? []).some(
            (e) => edgeKey(e.from, e.to) === edgeKey(target.from, target.to),
          );
    }
    return obs !== null && observedMatching(r.document, obs, target);
  });
  return adopting?.decidedAt ?? null;
}

/** A keep reads reconciled when an observation after its adopting approval matches the node to the approved plan. */
function adoptedReconciled(f: HealthFacts, target: NodeTarget, decision: Decision): boolean {
  const at = adoptionOf(f, target, decision);
  const obs = f.observation;
  const approved = approvedDocumentOf(f);
  return (
    at !== null &&
    obs !== null &&
    approved !== null &&
    obs.createdAt > at &&
    observedMatching(approved, obs, target)
  );
}

function lifecycleOf(
  f: HealthFacts,
  target: NodeTarget,
  kinds: readonly HealthMarkerKind[],
  decision: Decision | undefined,
): NodePhase | null {
  if (!decision) return kinds.length > 0 ? 'marked' : null;
  const after = buildsAfter(f, target, decision);
  if (after.length === 0) {
    const adopted = adoptionOf(f, target, decision);
    const obs = f.observation;
    if (!adopted || !obs || obs.createdAt <= adopted) return 'decided';
    return kinds.some((k) => PROVENANCE.has(k)) || !adoptedReconciled(f, target, decision)
      ? 'marked'
      : 'reconciled';
  }
  if (after.some((b) => OPEN_ISSUE(b.status))) return 'cleaning';
  const settled = Math.max(...after.map((b) => (b.closedAt ?? b.updatedAt).getTime()));
  const obs = f.observation;
  if (!obs || obs.createdAt.getTime() <= settled) return 'decided';
  return kinds.some((k) => PROVENANCE.has(k)) ? 'marked' : 'reconciled';
}

function reconciliationOf(
  f: HealthFacts,
  nodes: readonly HealthNode[],
  latestDecision: ReadonlyMap<string, Decision>,
): WorkflowReconciliation {
  const undecided = nodes.filter(
    (n) => !n.decision && n.kinds.some((k) => PROVENANCE.has(k)),
  ).length;
  const cleaning = nodes.filter((n) => n.phase === 'cleaning').length;
  const carried = new Map<string, HealthFacts['builds'][number]>();
  let unbuilt = 0;
  for (const d of latestDecision.values()) {
    const target = decisionTarget(d.node);
    const after = buildsAfter(f, target, d);
    for (const b of after) carried.set(b.issueKey, b);
    if (after.length === 0 && !adoptedReconciled(f, target, d)) unbuilt += 1;
  }
  const builds = [...carried.values()];
  const unreleased = builds.filter((b) => !b.release?.releasedAt);
  const newest = builds
    .map((b) => b.release)
    .filter((r): r is { version: string; releasedAt: Date } => r?.releasedAt != null)
    .sort((a, b) => b.releasedAt.getTime() - a.releasedAt.getTime())[0];
  const version =
    builds.length > 0 && unreleased.length === 0 && newest
      ? { version: newest.version, releasedAt: newest.releasedAt.toISOString() }
      : null;
  const criteria = {
    total: f.criteria.length,
    proven: f.criteria.filter((c) => c.proof === 'pass').length,
  };
  const why = !f.observation
    ? 'the code has not been observed against this design'
    : undecided > 0
      ? `${undecided} marked node(s) wait on a keep, rewrite or delete decision`
      : cleaning > 0
        ? `${cleaning} decided node(s) wait on their build issue to close`
        : unbuilt > 0
          ? `${unbuilt} decided node(s) have no build issue linked after the decision, and no approved revision adopting a kept one was observed`
          : builds.length === 0
            ? latestDecision.size === 0
              ? 'no node is marked or decided, so nothing waits on a reconciliation'
              : null
            : unreleased.length > 0
              ? `${unreleased.map((b) => b.issueKey).join(', ')} is not in a released version yet`
              : null;
  const reconciled =
    f.observation !== null &&
    undecided === 0 &&
    cleaning === 0 &&
    unbuilt === 0 &&
    (builds.length === 0 || version !== null);
  return {
    state: reconciled ? 'reconciled' : 'open',
    undecided,
    cleaning,
    issues: builds.map((b) => b.issueKey).sort(),
    version,
    criteria,
    rule:
      why ??
      (version
        ? `every marked node is decided and ${version.version} carried its builds`
        : 'every decided node is kept by an approved revision the code was observed to match'),
  };
}

function rewriteOf(
  f: HealthFacts,
  aspects: readonly MarkerAspect[],
  markerCount: number,
  problems: readonly { issue: string; at: Date }[],
): RewriteRule | null {
  const t = f.threshold;
  if (aspects.length >= t.aspects) return 'rewrite.divergence';
  if (markerCount >= t.markers) return 'rewrite.marker_count';
  const windowStart = f.now.getTime() - t.problemWindowDays * 86_400_000;
  const issues = new Set(problems.filter((p) => p.at.getTime() >= windowStart).map((p) => p.issue));
  return issues.size >= t.problemIssues ? 'rewrite.repeat_problem' : null;
}

function decisionView(d: HealthFacts['decisions'][number]): HealthNodeDecision {
  return {
    verdict: d.node.verdict,
    reason: d.reason,
    marker: d.node.marker ?? null,
    commentId: d.commentId,
    by: d.by,
    byName: d.byName,
    at: d.at.toISOString(),
  };
}

const VERDICT_ACT = {
  keep: 'propose a revision that adopts the code, or build it to the plan',
  rewrite: 'break the rewrite into issues',
  delete: 'break the deletion into issues',
} as const;

export function deriveHealth(f: HealthFacts): WorkflowHealth {
  const approved = approvedDocumentOf(f);
  const shown = f.proposed?.document ?? approved ?? f.head.document;
  const revision = f.proposed?.revision ?? f.approvedRevision ?? f.head.revision;
  const diff =
    f.proposed && approved ? designDiff(approved, f.proposed.document, f.template) : null;
  const out = new Markers();
  outdatedMarkers(f, out, approved, shown);
  needsUpdateMarkers(f, out, diff);
  const problems = problemMarkers(f, out);
  removeMarkers(f, out, diff, approved);
  const prov = provenanceOf(f, shown, out);

  // removed steps and lines are kept in place on the proposed drawing, as the diff view draws them
  for (const s of approved?.steps ?? []) {
    if (diff?.steps.get(s.id) === 'removed') {
      prov.nodes.set(`step:planned:${s.id}`, {
        target: { kind: 'step', step: s.id, layer: 'planned' },
        provenance: 'planned',
        aspects: [],
      });
    }
  }
  for (const e of approved?.edges ?? []) {
    if (diff?.edges.get(edgeKey(e.from, e.to)) === 'removed') {
      const target: NodeTarget = {
        kind: 'edge',
        from: e.from,
        to: e.to,
        label: e.label ?? null,
        layer: 'planned',
      };
      prov.nodes.set(targetKey(target), { target, provenance: 'planned', aspects: [] });
    }
  }

  const latestDecision = new Map<string, Decision>();
  for (const d of f.decisions) {
    const key = targetKey(decisionTarget(d.node));
    if (!latestDecision.has(key)) latestDecision.set(key, d);
  }

  const byTarget = new Map<string, HealthMarker[]>();
  for (const m of out.list) {
    const key = targetKey(m.target);
    byTarget.set(key, [...(byTarget.get(key) ?? []), m]);
  }

  const nodes: HealthNode[] = [];
  for (const [key, n] of prov.nodes) {
    const markers = byTarget.get(key) ?? [];
    const kinds = HEALTH_MARKER_KINDS.filter((k) => markers.some((m) => m.kind === k));
    const decision = latestDecision.get(key);
    const rule = rewriteOf(f, n.aspects, markers.length, problems.get(key) ?? []);
    const proposedDecision = rule
      ? 'rewrite'
      : kinds.includes('not_in_design')
        ? 'delete'
        : kinds.includes('upcoming')
          ? 'keep'
          : null;
    nodes.push({
      target: n.target,
      provenance: n.provenance,
      kinds,
      rewrite: decision ? `decided_${decision.node.verdict}` : rule ? 'due' : 'none',
      rewriteRule: rule,
      proposedDecision,
      phase: lifecycleOf(f, n.target, kinds, decision),
      decision: decision ? decisionView(decision) : null,
    });
    for (const m of markers) {
      if (!PROVENANCE.has(m.kind)) continue;
      if (decision) {
        m.waitingOn = masterOwes(
          VERDICT_ACT[decision.node.verdict],
          `the node is decided ${decision.node.verdict}`,
        );
      } else if (m.kind === 'not_in_design' || rule) {
        m.waitingOn = personDecides(
          m.kind === 'not_in_design'
            ? 'code the design does not hold waits on a decision: keep, rewrite or delete'
            : `the node is due a rewrite (${rule}); keeping it is a recorded decision against the default`,
        );
      } else if (m.kind === 'upcoming') {
        m.waitingOn = masterOwes(
          'build it to the plan',
          'a planned node no code builds yet is built to the plan',
        );
      } else {
        m.waitingOn = masterOwes(
          'decide keep or rewrite in the decision round',
          'an undecided Wrong node below the rewrite threshold waits on the orchestrator, not on a person',
        );
      }
    }
  }

  const counts = emptyHealthCounts();
  for (const m of out.list) counts[m.kind] += 1;
  const personSources = new Set(
    out.list
      .filter((m) => !PROVENANCE.has(m.kind) && waitsOnPerson(m.waitingOn))
      .map((m) => `${m.source.type}:${m.source.key}`),
  );
  const undecided = nodes.filter(
    (n) => !n.decision && (n.rewrite === 'due' || n.kinds.includes('not_in_design')),
  ).length;
  const obs = f.observation;
  return {
    workflowId: f.workflowId,
    flow: f.flow,
    revision,
    approvedRevision: f.approvedRevision,
    proposedRevision: f.proposed?.revision ?? null,
    rooted: f.rooted,
    observation: obs
      ? {
          id: obs.id,
          atSha: obs.atSha,
          revision: obs.revision,
          createdAt: obs.createdAt.toISOString(),
          writtenBy: obs.writtenBy,
          writtenByAgency: obs.writtenByAgency,
        }
      : null,
    markers: out.list,
    counts,
    nodes,
    workflowLevel: out.list.filter((m) => m.target.kind === 'workflow'),
    needsYou: personSources.size + undecided,
    orphanedTraces: orphansOf(f, diff),
    diff: diffView(diff, f.approvedRevision, f.proposed?.revision ?? null),
    observed: obs
      ? {
          steps: obs.document.steps.map((s) => ({
            id: s.id,
            matches: s.matches,
            title: s.title ?? null,
            does: s.does,
            after: s.after,
          })),
          edges: obs.document.edges.map((e) => ({
            from: e.from,
            to: e.to,
            label: e.label ?? null,
          })),
        }
      : null,
    threshold: f.threshold,
    reconciliation: reconciliationOf(f, nodes, latestDecision),
  };
}

export type { HealthFacts, PlannedTarget } from './health-facts.js';
