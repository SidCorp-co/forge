/**
 * The row a design owes the viewer on Needs you: the revision waiting on them to decide, as the design
 * itself (so the approval is a Workflow row a BA reads, not an issue decision they have to find), else
 * the health markers waiting on a person.
 */

import type { NeedsYouEntity } from '@forge/contracts/needs-you';
import { say } from '@forge/contracts/said';
import type { Standing } from '@forge/contracts/standing';
import { waitingOn } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';

interface DesignRow {
  entity: NeedsYouEntity;
  key: string;
  title: string;
  standing: Standing;
  touchedAt: string | null;
}

export function designRowOf(h: WorkflowHealth): DesignRow | null {
  const p = h.proposal;
  if (p && p.waitingOn.kind === 'you') {
    return {
      entity: 'workflow',
      key: h.flow,
      title: `${p.title} · revision ${p.revision} proposed`,
      standing: { attentionGroup: 'needs_you', waitingOn: p.waitingOn },
      touchedAt: p.proposedAt,
    };
  }
  if (h.needsYou <= 0) return null;
  return {
    entity: 'workflow',
    key: h.flow,
    title: h.flow,
    standing: {
      attentionGroup: 'needs_you',
      waitingOn: waitingOn(
        'person',
        {
          who: say('designs.who.aPerson'),
          act: say('designs.act.settleMarkers', {
            n: h.needsYou,
            markers: h.needsYou === 1 ? 'marker' : 'markers',
          }),
          rule: say('designs.rule.needsYou'),
        },
        { ref: h.flow },
      ),
    },
    touchedAt: h.markers.reduce<string | null>(
      (at, m) => (m.since && (!at || m.since > at) ? m.since : at),
      null,
    ),
  };
}
