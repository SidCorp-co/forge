// The decisions a requirement's delivery asks of a person (REQ-48 BC-11): the BA's acceptance once
// its issues shipped, and the take-on of draft issues nothing opens by itself. Each carries the
// rule's recommendation and the buttons the requirement's and the issue's own pages send.

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import type { AttentionRow } from './needs-you.js';
import { answer, type Built, clip, filled } from './needs-you-decision-builders.js';

/** The BA's check: accept the delivery of `revision`, or defer it with a reason. */
export function acceptDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  revision: number,
  criteria: { passing: number; total: number },
): Built {
  const params = { projectId, key: row.key };
  const proven = criteria.passing === criteria.total;
  return {
    questionId: null,
    decision: {
      group: 'accept',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Accept the delivery of ${row.key} at revision ${revision}?`,
      recommended: {
        answerId: proven ? 'accept' : 'defer',
        why: proven
          ? `All ${criteria.total} of its business criteria pass on the running build.`
          : `${criteria.total - criteria.passing} of its ${criteria.total} business criteria do not pass yet.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'accept',
          label: `Accept revision ${revision}`,
          act: 'requirement.accept',
          path: filled('requirement.accept', params),
          body: { revision },
          effect: `${row.key} is accepted as delivered.`,
          recommended: proven,
        }),
        answer({
          id: 'defer',
          label: 'Defer with a reason',
          act: 'requirement.defer',
          path: filled('requirement.defer', params),
          body: {},
          needsReason: true,
          effect: `${row.key} leaves the current release with your reason.`,
          recommended: !proven,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

/** A design or contract a requirement follows moved on: follow it at the head revision, as its page's Update does. */
export function repinDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  head: number,
): Built {
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Follow the approved designs and contracts in ${row.key} at revision ${head}?`,
      recommended: {
        answerId: 'repin',
        why: 'A new baseline pins the approved versions; the wording and criteria stay as they are.',
        by: 'rule',
      },
      noRecommendation: null,
      answers: [
        answer({
          id: 'repin',
          label: 'Update to the approved versions',
          act: 'requirement.repin',
          path: filled('requirement.repin', { projectId, key: row.key }),
          body: { revision: head },
          effect: `${row.key} follows the approved designs and contracts; delivery reads them next.`,
          recommended: true,
        }),
      ],
      touchedAt: row.touchedAt,
    },
  };
}

/** A requirement whose only issues are drafts: take each on, so the master can build it. */
export function admitDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  drafts: readonly { id: string; key: string }[],
): Built {
  const shown = drafts.slice(0, 7);
  const [first] = shown;
  if (!first) throw new Error(`needs-you: ${row.key} asks a draft taken on but has no draft issue`);
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: row.entity,
      key: row.key,
      title: clip(row.title, 500),
      opens: { kind: 'requirement', key: row.key },
      question: `Take on ${shown.map((d) => d.key).join(', ')} so ${row.key} can be built?`,
      recommended: {
        answerId: first.key,
        why: `${row.key} is agreed and only draft issues carry it; nothing takes a draft on by itself.`,
        by: 'rule',
      },
      noRecommendation: null,
      answers: shown.map((d, i) =>
        answer({
          id: d.key,
          label: `Take on ${d.key}`,
          act: 'issue.admit',
          path: filled('issue.admit', { issueId: d.id }),
          body: { toStatus: 'open' },
          effect: `${d.key} opens and the master can take it.`,
          recommended: i === 0,
        }),
      ),
      touchedAt: row.touchedAt,
    },
  };
}
