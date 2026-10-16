// The approve-group decisions the needs-me read builds (REQ-41 BC-2): a requirement revision's
// accept or return, a requirement's agree or drop, a release's approve or return, and a workflow
// design revision's approve or return, each with the rule's recommendation and the buttons that send it.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import type { AttentionRow } from './needs-you.js';
import { answer, type Built, clip, filled } from './needs-you-decision-builders.js';

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
          effect: `${row.key} is dropped and will not be built.`,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

export function releaseDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  release: { runId: string; failing: number; total: number },
  approvalId: string,
): Built {
  const params = { projectId: projectId, runId: release.runId, approvalId };
  const path = filled('release.decide', params);
  const clean = release.failing === 0;
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'release', key: row.key },
      question: `Approve release ${row.key} for production, or return it to the master?`,
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
          effect: 'The release may go to production.',
          recommended: clean,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'release.decide',
          path,
          body: { decision: 'return' },
          needsReason: true,
          effect: 'The master is told why and does not take it to production.',
          recommended: !clean,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

/** A workflow design revision proposed to the viewer: approve it, or return it to its writer with a reason. */
export function designDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  design: { workflowId: string; revision: number },
): Built {
  const n = design.revision;
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
      question: `Approve revision ${n} of the ${row.key} design, or return it to its writer?`,
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
          effect: `Revision ${n} becomes the approved design of ${row.key}.`,
          recommended: true,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'design.decide',
          path,
          body: { revision: n, decision: 'return' },
          needsReason: true,
          effect: 'Sends it back to its writer with your reason.',
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
