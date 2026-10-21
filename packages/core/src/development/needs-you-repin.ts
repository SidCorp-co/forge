/**
 * A moved design's pin-only dependents as one decision (REQ-48 BC-11): the designs built on a newly
 * approved design, moved to follow it by the one re-pin act (`design-repin-service.ts:repinAs`),
 * decided where it is listed with that act's own body: the base revision approved and each design at
 * the revision the plan read it at, so a design that moved since is refused by name, never re-pinned
 * blind. No act declines a re-pin; a person who will not take it leaves the designs where they are.
 */

import type { NeedsYouAreaKey } from '@forge/contracts/needs-you';
import { type DecisionProposal, fitProposal } from '@forge/contracts/needs-you-proposal';
import { cutAtWord } from '@forge/contracts/title-text';
import type { AttentionRow } from './needs-you.js';
import { type Built, filled } from './needs-you-decision-builders.js';
import type { DesignRepinGroup } from './ports.js';

const CHECKED = 'Each new revision differs only in which revision it follows';

const designs = (n: number) => (n === 1 ? '1 design' : `${n} designs`);
const pinsOf = (d: DesignRepinGroup['ready'][number]) =>
  d.pins.map((p) => `${p.workflow} r${p.from} → r${p.to}`).join(', ');

export function repinProposal(group: DesignRepinGroup): DecisionProposal {
  const n = group.ready.length;
  return {
    verb: `Follow r${group.revision}`,
    what: `${designs(n)} built on it ${n === 1 ? 'moves' : 'move'} to its approved revision`,
    recommends: true,
    tags: [
      { text: 'Only the followed revision changes', tone: 'ok' },
      ...(group.refused > 0
        ? [{ text: `${group.refused} cannot follow yet`, tone: 'warn' as const }]
        : []),
    ],
    consequences: group.ready.map((d) => `${d.flow} gets r${d.approves}, following ${pinsOf(d)}`),
    why: [
      { label: 'Changed', value: `“${group.title}” was approved at r${group.revision}` },
      {
        label: 'Built on it',
        value: `${designs(n)} still ${n === 1 ? 'follows' : 'follow'} an older revision`,
      },
      { label: 'Checked', value: CHECKED },
    ],
    said: null,
    table: {
      title: 'Designs that move',
      columns: ['Design', 'Follows now', 'After'],
      rows: group.ready.map((d) => [
        d.flow,
        d.pins.map((p) => `${p.workflow} r${p.from}`).join('\n'),
        d.pins.map((p) => `r${p.to}`).join('\n'),
      ]),
    },
    yields: [{ kind: 'design_update', n }],
  };
}

export function repinDecision(
  row: AttentionRow,
  area: NeedsYouAreaKey,
  projectId: string,
  group: DesignRepinGroup,
): Built {
  const n = group.ready.length;
  return {
    questionId: null,
    decision: {
      group: 'approve',
      area,
      entity: 'workflow',
      key: group.flow,
      title: cutAtWord(group.title, 500),
      opens: { kind: 'workflow', key: group.flow },
      question: `Move ${designs(n)} built on ${group.flow} to follow r${group.revision}?`,
      recommended: { answerId: 'approve', why: CHECKED, by: 'rule' },
      noRecommendation: null,
      answers: [
        {
          id: 'approve',
          label: `Follow r${group.revision}`,
          act: 'design.repin',
          path: filled('design.repin', { projectId, workflowId: group.baseId }),
          body: {
            revision: group.revision,
            designs: group.ready.map((d) => ({ workflowId: d.workflowId, revision: d.revision })),
          },
          needsReason: false,
          declines: false,
          effect: `${designs(n)} ${n === 1 ? 'is' : 'are'} approved at the revision that follows r${group.revision}.`,
          recommended: true,
        },
      ],
      touchedAt: row.touchedAt,
      id: `repin:${group.baseId}`,
      topic: 'design_update',
      proposal: fitProposal(repinProposal(group)),
    },
  };
}
