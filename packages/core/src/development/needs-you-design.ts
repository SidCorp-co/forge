/**
 * The row a design owes the viewer on Needs you: the revision waiting on them to decide, as the design
 * itself (so the approval is a Workflow row a BA reads, not an issue decision they have to find), else
 * the health markers waiting on a person.
 */

import { repinOwedWait, settleOwedWait } from '@forge/contracts/design-owed';
import type { NeedsYouEntity } from '@forge/contracts/needs-you';
import { say, verbatim } from '@forge/contracts/said';
import type { Standing } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import type { DesignRepinGroup } from './ports.js';
import { composedTitle, type RowTitle, writtenTitle } from './row-title.js';

interface DesignRow extends RowTitle {
  entity: NeedsYouEntity;
  key: string;
  standing: Standing;
  touchedAt: string | null;
}

/**
 * One row for a moved base's pin-only dependents, in place of a row per design: the act that clears
 * them is one, so the row is one (the HOP shape, where access r13 asked for six approvals).
 */
export function repinRowOf(group: DesignRepinGroup, canDecide: boolean): DesignRow {
  const n = group.ready.length;
  const title = say('designs.title.repinBatch', {
    n,
    designs: n === 1 ? 'design' : 'designs',
    need: n === 1 ? 'needs' : 'need',
    its: n === 1 ? 'its' : 'their',
    r: group.revision,
  });
  return {
    entity: 'workflow',
    key: group.flow,
    ...composedTitle(title),
    standing: {
      attentionGroup: 'needs_you',
      // the one wait the design's own page says too (`@forge/contracts/design-owed`)
      waitingOn: repinOwedWait({ flow: group.flow, revision: group.revision, n }, canDecide),
    },
    touchedAt: group.approvedAt,
  };
}

/** `settleBy`: who settles the places its code and design differ (`whoOwes('design.decide')`, ISS-1068). */
export function designRowOf(h: WorkflowHealth, settleBy: 'person' | 'master'): DesignRow | null {
  const p = h.proposal;
  if (p && p.waitingOn.kind === 'you') {
    return {
      entity: 'workflow',
      key: h.flow,
      ...composedTitle(
        say('needsYou.title.designProposed', { title: verbatim(p.title), revision: p.revision }),
      ),
      standing: { attentionGroup: 'needs_you', waitingOn: p.waitingOn },
      touchedAt: p.proposedAt,
    };
  }
  if (h.needsYou <= 0) return null;
  return {
    entity: 'workflow',
    key: h.flow,
    ...writtenTitle(h.title ?? h.flow, null),
    standing: {
      attentionGroup: settleBy === 'person' ? 'needs_you' : 'waiting',
      waitingOn: settleOwedWait(h.needsYou, h.flow, settleBy),
    },
    touchedAt: h.markers.reduce<string | null>(
      (at, m) => (m.since && (!at || m.since > at) ? m.since : at),
      null,
    ),
  };
}
