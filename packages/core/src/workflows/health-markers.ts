/**
 * The marker decisions (workflow-step-health `d-outdated`, `d-needs-update`, `d-has-problem`,
 * `d-remove-proposed`, `d-orphans`, `d-provenance`): each reads its records and adds one marker per
 * matching row, naming its rule, reason and source.
 */

import type {
  HealthNode,
  MarkerAspect,
  MarkerSource,
  OrphanedTrace,
  OrphanRecordType,
} from '@forge/contracts/workflow-health';
import { type DesignDiff, designDiff, edgeKey } from './design-diff.js';
import {
  documentAt,
  type HealthFacts,
  hrefs,
  iso,
  type Markers,
  masterOwes,
  type NodeTarget,
  OPEN_ISSUE,
  type PlannedTarget,
  planned,
  short,
  targetKey,
  wait,
} from './health-facts.js';
import { matchLayers } from './health-match.js';
import type { WorkflowWrite } from './schema.js';

export function outdatedMarkers(
  f: HealthFacts,
  out: Markers,
  approved: WorkflowWrite | null,
  shown: WorkflowWrite | null,
): void {
  const link = hrefs(f);
  const approvedAt = f.revisions.find((r) => r.revision === f.approvedRevision)?.decidedAt ?? null;
  if (approvedAt) {
    for (const c of f.criteria) {
      if (!c.sinceAcceptedAt || c.sinceAcceptedAt <= approvedAt) continue;
      out.add(c.targets.map(planned), {
        kind: 'outdated',
        rule: 'outdated.criterion_reworded',
        reason: `${c.requirementKey} ${c.code} reworded in r${c.sinceRevision} after design r${f.approvedRevision} was approved`,
        source: {
          type: 'requirement_criterion',
          key: `${c.requirementKey} ${c.code}`,
          href: link.requirement(c.requirementKey),
        },
        waitingOn: masterOwes(
          'revise the design to the new wording',
          'outdated.criterion_reworded',
        ),
        since: iso(c.sinceAcceptedAt),
      });
    }
  }
  for (const s of shown?.steps ?? []) {
    for (const c of s.node?.contracts ?? []) {
      for (const pin of f.contractPins) {
        if (pin.provider !== c.provider || pin.slug !== c.slug || !pin.newestBreaking) continue;
        out.add([{ kind: 'step', step: s.id, layer: 'planned' }], {
          kind: 'outdated',
          rule: 'outdated.contract_breaking',
          reason: `${c.provider}/${c.slug} v${pin.newestBreaking.version} is breaking; the baseline pins v${pin.pinnedVersion}`,
          source: {
            type: 'contract_version',
            key: `${c.provider}/${c.slug}@${pin.newestBreaking.version}`,
            href: link.contract(c.provider),
          },
          waitingOn: masterOwes('revise the design to the contract', 'outdated.contract_breaking'),
          since: iso(pin.newestBreaking.recordedAt),
        });
      }
    }
  }
  if (approved && f.approvedRevision !== null) {
    const dA = f.approvedRevision;
    for (const b of f.builds) {
      for (const j of b.judgedAgainst) {
        if (j.revision >= dA) continue;
        const older = documentAt(f, j.revision);
        if (!older) continue;
        const diff = designDiff(older, approved, f.template);
        const changed = b.targets.filter(
          (t) => t.kind === 'step' && diff.steps.get(t.step) === 'changed',
        );
        out.add(changed.map(planned), {
          kind: 'outdated',
          rule: 'outdated.built_behind',
          reason: `built against r${j.revision}, the step changed in r${dA}`,
          source: {
            type: 'criterion_verdict',
            key: `${b.issueKey} r${j.revision}`,
            href: link.issue(b.issueKey),
          },
          waitingOn: masterOwes('repair the build to the approved design', 'outdated.built_behind'),
          since: iso(j.at),
        });
      }
    }
  }
  const obs = f.observation;
  if (obs?.document.drift) {
    const byId = new Map(obs.document.steps.map((s) => [s.id, s]));
    const targets: NodeTarget[] = obs.document.drift.steps.map((id) => {
      const m = byId.get(id)?.matches;
      return m
        ? { kind: 'step', step: m, layer: 'planned' }
        : { kind: 'step', step: id, layer: 'observed' };
    });
    out.add(targets, {
      kind: 'outdated',
      rule: 'outdated.drift',
      reason: `the code moved under this step at ${short(obs.atSha)}: ${obs.document.drift.reason}`,
      source: { type: 'workflow_observation', key: obs.atSha, href: link.observation() },
      waitingOn: masterOwes('observe the workflow again', 'outdated.drift'),
      since: iso(obs.createdAt),
    });
  }
}

export function needsUpdateMarkers(f: HealthFacts, out: Markers, diff: DesignDiff | null): void {
  const link = hrefs(f);
  for (const fb of f.feedback) {
    out.add(fb.target ? [planned(fb.target)] : [], {
      kind: 'needs_update',
      rule: 'needs_update.feedback_open',
      reason: fb.title,
      source: { type: 'feedback', key: fb.key, href: link.feedback(fb.key) },
      waitingOn: fb.waitingOn,
      since: iso(fb.createdAt),
    });
  }
  for (const s of f.suggestions) {
    if (s.status !== 'accepted' || s.change !== 'change' || !s.decidedAt) continue;
    if (f.lastProposedAt && f.lastProposedAt > s.decidedAt) continue;
    out.add(s.targets.map(planned), {
      kind: 'needs_update',
      rule: 'needs_update.suggestion_accepted',
      reason: s.reason,
      source: { type: 'suggestion', key: s.id, href: null },
      waitingOn: masterOwes('propose a design revision', 'needs_update.suggestion_accepted'),
      since: iso(s.decidedAt),
    });
  }
  const p = f.proposed;
  if (diff && p) {
    const source: MarkerSource = {
      type: 'design_revision',
      key: `r${p.revision}`,
      href: link.revision(p.revision),
    };
    for (const [id, mark] of diff.steps) {
      if (mark !== 'changed') continue;
      out.add([{ kind: 'step', step: id, layer: 'planned' }], {
        kind: 'needs_update',
        rule: 'needs_update.revision_changes',
        reason: `r${p.revision} changes this step`,
        source,
        waitingOn: p.waitingOn,
        since: iso(p.proposedAt),
      });
    }
    for (const e of p.document.edges ?? []) {
      if (diff.edges.get(edgeKey(e.from, e.to)) !== 'changed') continue;
      out.add(
        [{ kind: 'edge', from: e.from, to: e.to, label: e.label ?? null, layer: 'planned' }],
        {
          kind: 'needs_update',
          rule: 'needs_update.revision_changes',
          reason: `r${p.revision} changes this line`,
          source,
          waitingOn: p.waitingOn,
          since: iso(p.proposedAt),
        },
      );
    }
  }
}

/** Has a problem, and the moments each build had one (for `rewrite.repeat_problem`). */
export function problemMarkers(
  f: HealthFacts,
  out: Markers,
): Map<string, { issue: string; at: Date }[]> {
  const link = hrefs(f);
  const problems = new Map<string, { issue: string; at: Date }[]>();
  for (const b of f.builds) {
    const targets = b.targets.map(planned);
    const record = (at: Date) => {
      for (const t of targets.length ? targets : [{ kind: 'workflow' } as const]) {
        const key = targetKey(t);
        problems.set(key, [...(problems.get(key) ?? []), { issue: b.issueKey, at }]);
      }
    };
    const repair = masterOwes('repair the build', 'has_problem');
    for (const v of b.failing) {
      out.add(targets, {
        kind: 'has_problem',
        rule: 'has_problem.verdict_fail',
        reason: `${b.issueKey} criterion ${v.n} failed${v.reason ? `: ${v.reason}` : ''}`,
        source: {
          type: 'criterion_verdict',
          key: `${b.issueKey} #${v.n}`,
          href: link.issue(b.issueKey),
        },
        waitingOn: repair,
        since: iso(v.at),
      });
      record(v.at);
    }
    if (b.status === 'reopen' || (b.reopenCount > 0 && OPEN_ISSUE(b.status))) {
      out.add(targets, {
        kind: 'has_problem',
        rule: 'has_problem.reopened',
        reason: `${b.issueKey} was reopened and is not closed again`,
        source: { type: 'issue', key: b.issueKey, href: link.issue(b.issueKey) },
        waitingOn: repair,
        since: iso(b.updatedAt),
      });
      record(b.updatedAt);
    }
    const run = b.run;
    if (run && (run.state === 'stuck' || run.state === 'failed')) {
      out.add(targets, {
        kind: 'has_problem',
        rule: run.state === 'stuck' ? 'has_problem.run_stuck' : 'has_problem.run_failed',
        reason: run.rule,
        source: { type: 'run', key: run.id, href: link.run(run.id) },
        waitingOn: masterOwes(`recover the ${run.state} run`, `has_problem.run_${run.state}`),
        since: run.since,
      });
      record(run.since ? new Date(run.since) : f.now);
    }
  }
  return problems;
}

export function removeMarkers(
  f: HealthFacts,
  out: Markers,
  diff: DesignDiff | null,
  approved: WorkflowWrite | null,
): void {
  const link = hrefs(f);
  const p = f.proposed;
  if (diff && p && approved) {
    const source: MarkerSource = {
      type: 'design_revision',
      key: `r${p.revision}`,
      href: link.revision(p.revision),
    };
    for (const [id, mark] of diff.steps) {
      if (mark !== 'removed') continue;
      out.add([{ kind: 'step', step: id, layer: 'planned' }], {
        kind: 'remove_proposed',
        rule: 'remove_proposed.revision',
        reason: `r${p.revision} removes this step`,
        source,
        waitingOn: p.waitingOn,
        since: iso(p.proposedAt),
      });
    }
    for (const e of approved.edges ?? []) {
      if (diff.edges.get(edgeKey(e.from, e.to)) !== 'removed') continue;
      const moved = (p.document.edges ?? []).find(
        (n) =>
          n.from === e.from && n.to !== e.to && diff.edges.get(edgeKey(n.from, n.to)) === 'added',
      );
      out.add(
        [{ kind: 'edge', from: e.from, to: e.to, label: e.label ?? null, layer: 'planned' }],
        {
          kind: 'remove_proposed',
          rule: 'remove_proposed.revision',
          reason: moved
            ? `r${p.revision} rewires this line to ${moved.to}`
            : `r${p.revision} removes this line`,
          source,
          waitingOn: p.waitingOn,
          since: iso(p.proposedAt),
        },
      );
    }
  }
  for (const s of f.suggestions) {
    if (s.status !== 'proposed' || s.change === 'change') continue;
    out.add(s.targets.map(planned), {
      kind: 'remove_proposed',
      rule: 'remove_proposed.suggestion',
      reason: s.reason,
      source: { type: 'suggestion', key: s.id, href: null },
      waitingOn: wait(
        'person',
        'A holder of suggestions.approve',
        'accept or reject the suggestion',
        'remove_proposed.suggestion',
      ),
      since: iso(s.createdAt),
    });
  }
}

export function orphansOf(f: HealthFacts, diff: DesignDiff | null): OrphanedTrace[] {
  if (!diff) return [];
  const link = hrefs(f);
  const gone = (t: PlannedTarget) =>
    t.kind === 'step'
      ? diff.steps.get(t.step) === 'removed'
      : diff.edges.get(edgeKey(t.from, t.to)) === 'removed';
  const out: OrphanedTrace[] = [];
  const seen = new Set<string>();
  const list = (
    targets: readonly PlannedTarget[],
    recordType: OrphanRecordType,
    key: string,
    href: string | null,
  ) => {
    for (const t of targets.filter(gone)) {
      const target = planned(t);
      const k = `${targetKey(target)}|${recordType}|${key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ target, recordType, key, href });
    }
  };
  for (const c of f.criteria) {
    list(
      c.targets,
      'requirement_criterion',
      `${c.requirementKey} ${c.code}`,
      link.requirement(c.requirementKey),
    );
  }
  for (const fb of f.feedback)
    if (fb.target) list([fb.target], 'feedback', fb.key, link.feedback(fb.key));
  for (const s of f.suggestions) list(s.targets, 'suggestion', s.id, null);
  for (const b of f.builds) list(b.targets, 'build', b.issueKey, link.issue(b.issueKey));
  return out;
}

export interface Provenance {
  nodes: Map<
    string,
    { target: NodeTarget; provenance: HealthNode['provenance']; aspects: MarkerAspect[] }
  >;
}

export function provenanceOf(
  f: HealthFacts,
  shown: WorkflowWrite | null,
  out: Markers,
): Provenance {
  const nodes: Provenance['nodes'] = new Map();
  const put = (
    target: NodeTarget,
    provenance: HealthNode['provenance'],
    aspects: MarkerAspect[] = [],
  ) => nodes.set(targetKey(target), { target, provenance, aspects });
  for (const s of shown?.steps ?? [])
    put({ kind: 'step', step: s.id, layer: 'planned' }, 'planned');
  for (const e of shown?.edges ?? []) {
    put(
      { kind: 'edge', from: e.from, to: e.to, label: e.label ?? null, layer: 'planned' },
      'planned',
    );
  }
  const obs = f.observation;
  if (!obs || !shown) return { nodes };
  const link = hrefs(f);
  const source: MarkerSource = {
    type: 'workflow_observation',
    key: obs.atSha,
    href: link.observation(),
  };
  const since = iso(obs.createdAt);
  const placeholder = masterOwes('', 'provenance');
  const match = matchLayers(shown, obs.document);
  for (const id of match.plannedOnlySteps) {
    out.add([{ kind: 'step', step: id, layer: 'planned' }], {
      kind: 'upcoming',
      rule: 'provenance.planned_only',
      reason: `no code builds this yet (observed at ${short(obs.atSha)})`,
      source,
      waitingOn: placeholder,
      since,
    });
  }
  for (const e of match.plannedOnlyEdges) {
    out.add([{ kind: 'edge', ...e, layer: 'planned' }], {
      kind: 'upcoming',
      rule: 'provenance.planned_only',
      reason: `no code builds this yet (observed at ${short(obs.atSha)})`,
      source,
      waitingOn: placeholder,
      since,
    });
  }
  for (const [id, pair] of match.steps) {
    const target: NodeTarget = { kind: 'step', step: id, layer: 'planned' };
    put(target, 'matched', pair.aspects);
    if (pair.aspects.length === 0) continue;
    out.add([target], {
      kind: 'wrong',
      rule: 'provenance.diverged',
      reason: `the code differs from the plan in ${pair.aspects.join(', ')}`,
      source,
      waitingOn: placeholder,
      since,
      aspects: pair.aspects,
    });
  }
  for (const e of shown.edges ?? []) {
    const aspects = match.edges.get(edgeKey(e.from, e.to));
    if (!aspects) continue;
    const target: NodeTarget = {
      kind: 'edge',
      from: e.from,
      to: e.to,
      label: e.label ?? null,
      layer: 'planned',
    };
    put(target, 'matched', aspects);
    if (aspects.length === 0) continue;
    out.add([target], {
      kind: 'wrong',
      rule: 'provenance.diverged',
      reason: `the code differs from the plan in ${aspects.join(', ')}`,
      source,
      waitingOn: placeholder,
      since,
      aspects,
    });
  }
  const notInDesign = (target: NodeTarget) => {
    put(target, 'observed');
    out.add([target], {
      kind: 'not_in_design',
      rule: 'provenance.observed_only',
      reason: 'the code holds this, the design does not',
      source,
      waitingOn: placeholder,
      since,
    });
  };
  for (const id of match.observedOnlySteps)
    notInDesign({ kind: 'step', step: id, layer: 'observed' });
  for (const e of match.observedOnlyEdges) notInDesign({ kind: 'edge', ...e, layer: 'observed' });
  return { nodes };
}
