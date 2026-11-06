// A drafted release's approval in Needs you (ISS-1075): on a project declaring no production that
// requires a person's release approval, the approval comes before the master records the landing, so
// it is a decision its listed approvers press, through the draft's own door.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import type { AttentionRow } from './needs-you.js';
import { answer, type Built, clip, filled, impactOf } from './needs-you-decision-builders.js';

/**
 * A drafted release its project requires a person to approve before the master records its landing,
 * on a project declaring no production (ISS-1075): its listed approvers decide it on its version,
 * through the draft's own door. Pressed, the approval frees the record to the master.
 */
export function draftApprovalDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
): Built {
  const path = filled('release.decideDraft', { projectId, version: row.key });
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
        'Approve this release, so the master records its landing, or return it to the master?',
      changes: `Whether ${row.key}'s landing is recorded as released`,
      impact: impactOf(row, 'the issues it carries stay unreleased until it is approved'),
      recommended: null,
      noRecommendation: 'The release page shows what it carries and how its criteria stand.',
      answers: [
        answer({
          id: 'approve',
          label: `Approve ${row.key}`,
          act: 'release.decideDraft',
          path,
          body: { decision: 'approve' },
          needsReason: true,
          effect: 'The master records the landing.',
          recommended: false,
        }),
        answer({
          id: 'return',
          label: 'Return with a reason',
          act: 'release.decideDraft',
          path,
          body: { decision: 'return' },
          needsReason: true,
          declines: true,
          effect: 'The master is told why and records nothing.',
          recommended: false,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
