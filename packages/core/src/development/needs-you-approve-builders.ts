// The approve-group decisions the needs-me read builds (REQ-41 BC-2): a requirement revision's
// accept or return, a requirement's agree or drop, a release's cut and its approve or return, and a
// workflow design revision's approve or return, each with the rule's recommendation and the buttons
// that send it.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import { type DecisionProposal, fitProposal } from '@forge/contracts/needs-you-proposal';
import {
  RELEASE_PROOF_LABELS,
  type ReleaseContentGroup,
  type ReleaseCriteriaTotals,
} from '@forge/contracts/releases';
import type { AttentionRow } from './needs-you.js';
import {
  answer,
  type Built,
  clip,
  type DecisionBody,
  filled,
} from './needs-you-decision-builders.js';

export function revisionDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  n: number,
): Built {
  const params = { projectId: projectId, key: row.key, n };
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Accept revision ${n} of ${row.key}, or return it to its author?`,
      recommended: {
        answerId: 'accept',
        why: `Its author proposed revision ${n} for sign-off; accept it unless its change summary is not what you asked for.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'accept',
          label: `Accept revision ${n}`,
          act: 'revision.accept',
          path: filled('revision.accept', params),
          body: {},
          effect: `Revision ${n} becomes the current revision of ${row.key}.`,
          recommended: true,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'revision.return',
          path: filled('revision.return', params),
          body: {},
          needsReason: true,
          declines: true,
          effect: 'Sends it back to its author with your reason.',
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

export function agreeDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  head: number,
): Built {
  const params = { projectId: projectId, key: row.key };
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Agree ${row.key} at revision ${head}, or drop it?`,
      recommended: {
        answerId: 'agree',
        why: 'Its linked designs are approved and it waits only on an agree; drop it with a reason if it should not be built.',
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'agree',
          label: `Agree revision ${head}`,
          act: 'requirement.agree',
          path: filled('requirement.agree', params),
          body: { revision: head },
          // an agree writes a baseline, and a baseline records why (REQ-4 BC-4)
          needsReason: true,
          effect: `${row.key} is agreed at revision ${head} and goes to delivery.`,
          recommended: true,
        }),
        answer({
          id: 'drop',
          label: 'Drop with a reason',
          act: 'requirement.drop',
          path: filled('requirement.drop', params),
          body: {},
          needsReason: true,
          declines: true,
          effect: `${row.key} is dropped and will not be built.`,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

/** A release's change requests, each once, in the order it merges them (REQ-63 BC-5). */
export type ReleaseDecisionRequests = NonNullable<DecisionBody['changeRequests']>;

export function changeRequestsOfContents(
  contents: readonly ReleaseContentGroup[],
): ReleaseDecisionRequests {
  const byLabel = new Map<string, ReleaseDecisionRequests[number]>();
  for (const issue of contents.flatMap((g) => g.issues)) {
    const cr = issue.changeRequest;
    if (!cr) continue;
    const held = byLabel.get(cr.label) ?? {
      label: cr.label,
      url: cr.url,
      state: cr.state,
      order: cr.order,
      issues: [],
    };
    held.issues.push(issue.key);
    byLabel.set(cr.label, held);
  }
  return [...byLabel.values()].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.label.localeCompare(b.label, 'en', { numeric: true }),
  );
}

/** What a release decision is built from, read off the release's summary. */
export interface ReleaseFacts {
  runId: string | null;
  failing: number;
  total: number;
  changeRequests: ReleaseDecisionRequests;
}

export function releaseFactsOf(r: {
  runId: string | null;
  criteria: ReleaseCriteriaTotals;
  contents: readonly ReleaseContentGroup[];
}): ReleaseFacts {
  return {
    runId: r.runId,
    failing: r.criteria.failing,
    total: r.criteria.total,
    changeRequests: changeRequestsOfContents(r.contents),
  };
}

export function releaseDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  release: ReleaseFacts & { runId: string },
  approvalId: string,
): Built {
  const params = { projectId: projectId, runId: release.runId, approvalId };
  const path = filled('release.decide', params);
  const clean = release.failing === 0;
  // a release that merges change requests is accepted for its merges, not for a deploy (REQ-63)
  const merges = release.changeRequests.filter((c) => c.order !== null);
  const order = merges.map((c) => c.label).join(', ');
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'release', key: row.key },
      question:
        merges.length > 0
          ? `Accept this release, so the master merges ${order} in that order, or return it to the master?`
          : 'Approve this release for production, or return it to the master?',
      recommended: {
        answerId: clean ? 'approve' : 'return',
        why: clean
          ? `None of the ${release.total} criteria it carries is failing.`
          : `${release.failing} of the ${release.total} criteria it carries are failing.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'approve',
          label: `Approve ${row.key}`,
          act: 'release.decide',
          path,
          body: { decision: 'approve' },
          needsReason: true,
          effect:
            merges.length > 0
              ? `The master merges ${clip(order, 200)} in that order; nothing merges before.`
              : 'The release may go to production.',
          recommended: clean,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'release.decide',
          path,
          body: { decision: 'return' },
          needsReason: true,
          declines: true,
          effect:
            merges.length > 0
              ? 'The master is told why and merges nothing.'
              : 'The master is told why and does not take it to production.',
          recommended: !clean,
        }),
      ],
      touchedAt: row.touchedAt,
      ...(release.changeRequests.length > 0 ? { changeRequests: release.changeRequests } : {}),
    },
  };
}

/** A draft release the viewer may cut: its version, the issues it carries and what they prove. */
export interface CuttableRelease {
  version: string;
  contents: readonly ReleaseContentGroup[];
  criteria: ReleaseCriteriaTotals;
}

/** Whether the criteria a cut carries say it is ready: every one earned, else what is not, and why. */
function cutRecommendation(n: number, c: ReleaseCriteriaTotals) {
  if (c.total > 0 && c.proven === c.total) {
    return { why: `All ${c.total} criteria its ${n} issues carry are earned.`, clean: true };
  }
  if (c.total === 0) {
    return {
      why: `None of its ${n} issues records a criterion, so nothing says it is ready; check it before you cut it.`,
      clean: false,
    };
  }
  const parts = [
    c.failing && `${c.failing} failing`,
    c.open && `${c.open} not judged yet`,
    c.unproven && `${c.unproven} judged, not proven`,
  ].filter(Boolean);
  return {
    why: `${c.proven} of the ${c.total} criteria its issues carry are earned (${parts.join(', ')}); check them before you cut it.`,
    clean: false,
  };
}

/**
 * A draft release no gate holds, waiting on the admin who may cut it (REQ-48 BC-11): the steward
 * may not cut, so the admin's cut is the decision, sent through the release page's own door
 * (`release.cut`, `POST …/release-batches {issueIds}`) with every issue the draft carries. The
 * peek lists those issues and what each proves; the rule recommends the cut only where every
 * criterion they carry is earned.
 */
export function cutDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  release: CuttableRelease,
): Built {
  const issues = release.contents.flatMap((g) => g.issues);
  const keys = issues.map((i) => i.key);
  const { why, clean } = cutRecommendation(issues.length, release.criteria);
  const carries = `Cuts ${release.version} carrying ${keys.join(', ')}`;
  const proposal: DecisionProposal = fitProposal({
    verb: `Cut ${release.version}`,
    what: `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`,
    recommends: clean,
    tags: [],
    consequences: [carries],
    why: [{ label: 'Criteria', value: why }],
    said: null,
    table: {
      title: 'Issues it carries',
      columns: ['Issue', 'Title', 'Criteria'],
      rows: issues.map((i) => [i.key, i.title, RELEASE_PROOF_LABELS[i.proof]]),
    },
    yields: [],
  });
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'release', key: row.key },
      question: `Cut this release with the ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} waiting for it?`,
      recommended: clean ? { answerId: 'cut', why, by: 'rule' } : null,
      noRecommendation: clean ? null : why,
      answers: [
        answer({
          id: 'cut',
          label: `Cut ${release.version}`,
          act: 'release.cut',
          path: filled('release.cut', { projectId }),
          body: { issueIds: issues.map((i) => i.id) },
          effect: carries,
          recommended: clean,
        }),
      ],
      touchedAt: row.touchedAt,
      topic: 'release',
      proposal,
    },
  };
}

/** A workflow design revision proposed to the viewer: approve it, or return it to its writer with a reason. */
export function designDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  design: { workflowId: string; revision: number; title: string },
): Built {
  const n = design.revision;
  const named = `"${clip(design.title, 200)}"`;
  const path = filled('design.decide', { projectId, workflowId: design.workflowId });
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'workflow', key: row.key },
      question: `Approve revision ${n} of ${named}, or return it to its writer?`,
      recommended: {
        answerId: 'approve',
        why: `Its writer proposed revision ${n} for approval; return it with a reason if it does not draw the journey you mean.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'approve',
          label: `Approve revision ${n}`,
          act: 'design.decide',
          path,
          body: { revision: n, decision: 'approve' },
          effect: `Revision ${n} becomes the approved design of ${named}.`,
          recommended: true,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'design.decide',
          path,
          body: { revision: n, decision: 'return' },
          needsReason: true,
          declines: true,
          effect: 'Sends it back to its writer with your reason.',
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
