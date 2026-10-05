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

function lifecycleOf(
  f: HealthFacts,
  target: NodeTarget,
  kinds: readonly HealthMarkerKind[],
  decision: HealthFacts['decisions'][number] | undefined,
): NodePhase | null {
  if (!decision) return kinds.length > 0 ? 'marked' : null;
  const steps = target.kind === 'step' ? [target.step] : [target.from, target.to];
  const after = f.builds.filter(
    (b) =>
      target.layer === 'planned' &&
      b.linkedAt > decision.at &&
      b.targets.some((t) => t.kind === 'step' && steps.includes(t.step)),
  );
  if (after.some((b) => OPEN_ISSUE(b.status))) return 'cleaning';
  const settled = Math.max(
    decision.at.getTime(),
    ...after.map((b) => (b.closedAt ?? b.updatedAt).getTime()),
  );
  const obs = f.observation;
  if (!obs || obs.createdAt.getTime() <= settled) return 'decided';
  return kinds.some((k) => PROVENANCE.has(k)) ? 'marked' : 'reconciled';
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

  const latestDecision = new Map<string, HealthFacts['decisions'][number]>();
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
  };
}

export type { HealthFacts, PlannedTarget } from './health-facts.js';
