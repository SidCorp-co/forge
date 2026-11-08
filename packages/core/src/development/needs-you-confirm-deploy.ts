// A release run's production deploy parked for a person's press (ISS-1096), as the needs-me read
// offers it: one decision whose one button is the binding's own confirm door.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import type { AttentionRow } from './needs-you.js';
import { answer, type Built, clip, filled, impactOf } from './needs-you-decision-builders.js';

/**
 * A release run's production deploy parked for a person's press (ISS-1096): one button, the
 * binding's own confirm door, which queues the deploy and carries the run on to its finish.
 */
export function confirmDeployDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  bindingId: string,
): Built {
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'release', key: row.key },
      question: `Confirm the production deploy of ${row.key}?`,
      changes: `Whether ${row.key} goes to production now`,
      impact: impactOf(row, 'its release run waits open until it is confirmed'),
      recommended: null,
      noRecommendation: 'The release page shows what it carries and how its criteria stand.',
      answers: [
        answer({
          id: 'confirm',
          label: `Confirm ${row.key}`,
          act: 'release.confirmDeploy',
          path: filled('release.confirmDeploy', { projectId, bindingId }),
          body: {},
          effect: 'The deploy goes out, and the release run carries on to its finish.',
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}
