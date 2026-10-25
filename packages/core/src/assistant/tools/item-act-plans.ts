// What each item kind's page offers a person, read as that person (REQ-69 BC-3, BC-6): one adapter
// per kind behind one port, `planItemAct`. Each reads the item through its module's own read, as the
// page does, and answers the plan its card carries (the revision, the approval, the issues a cut
// takes), or the refusal naming why the act is not one the item's state allows or the person may
// take. The press goes through the page's own route, which checks both again; this read is so a card
// is never offered for a press that could only fail.

import type { ItemAct } from '@forge/contracts/item-acts';
import { detailAs as readFeedbackAs } from '../../feedback/index.js';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { readRequirementAs } from '../../requirements/index.js';
import { type Asker, found, type ItemActReading, no, offer, unknown } from './item-act-plan-kit.js';
import { planRelease } from './item-act-plan-release.js';
import { planWorkflow } from './item-act-plan-workflow.js';

export type { ItemActPlan, ItemActReading, ItemActRefused } from './item-act-plan-kit.js';

const notSigner = (key: string, act: string) =>
  no(
    'ITEM_ACT_FORBIDDEN',
    `the person asking does not hold the sign-off on this project's requirements (requirements.approve), so ${act} on ${key} is not theirs to press; a project admin can.`,
  );

// the page offers defer while the requirement is not yet in delivery, and drop until it ends
const DEFERRABLE = new Set(['draft', 'agreed']);
const DROPPABLE = new Set(['draft', 'agreed', 'in_delivery', 'deferred']);

async function planRequirement(act: ItemAct, key: string, at: Asker): Promise<ItemActReading> {
  const d = await found(
    readRequirementAs({ userId: at.userId, agency: 'human' }, at.projectId, key),
  );
  if (!d) return unknown('requirement', key);
  const base = { key: d.key, ref: d.key, title: d.title, from: d.status };
  const draft = d.revisions.find((r) => r.state === 'draft');
  const proposed = d.revisions.find((r) => r.state === 'proposed');
  const head = d.revisions.find((r) => r.state === 'current');
  const state = (allows: string) =>
    no('ITEM_ACT_NOT_FROM_STATE', `${d.key} is ${d.status}, and ${act} applies to ${allows}.`);
  switch (act) {
    case 'requirement.propose': {
      if (!draft) return state('a requirement with a draft revision that is not yet proposed');
      const writes = await can(actorFor(at.userId), 'project.write', projectResource(at.projectId));
      if (!writes)
        return no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking does not hold project.write, so proposing ${d.key} is not theirs to press.`,
        );
      return offer({ ...base, revision: draft.revision });
    }
    case 'requirement.agree': {
      if (d.status !== 'draft' || !head || draft)
        return state('a draft requirement whose revision is written and not being edited');
      if (!d.canSignOff) return notSigner(d.key, act);
      const held = d.standing.facts.unapprovedDesigns;
      if (held.length > 0)
        return state(
          `a requirement whose designs are approved, and ${held.map((x) => x.title).join(', ')} is not yet`,
        );
      return offer({ ...base, revision: head.revision });
    }
    case 'requirement.accept':
    case 'requirement.return':
      if (!proposed) return state('a requirement with a proposed revision');
      if (!d.canSignOff) return notSigner(d.key, act);
      return offer({ ...base, revision: proposed.revision });
    case 'requirement.defer':
      if (!DEFERRABLE.has(d.status)) return state('a draft or agreed requirement');
      return d.canSignOff ? offer(base) : notSigner(d.key, act);
    case 'requirement.undefer':
      if (d.status !== 'deferred') return state('a deferred requirement');
      return d.canSignOff ? offer(base) : notSigner(d.key, act);
    case 'requirement.drop':
      if (!DROPPABLE.has(d.status))
        return state('a requirement that is not delivered, dropped or refused');
      return d.canSignOff ? offer(base) : notSigner(d.key, act);
    case 'requirement.accept_delivery':
      if (d.status !== 'delivered' || !head) return state('a delivered requirement');
      if (!d.canAccept)
        return no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking may not accept ${d.key}'s delivery on this project; whoever holds the acceptance can.`,
        );
      return offer({ ...base, revision: head.revision });
    default:
      return no('ITEM_ACT_INVALID', `${act} is not a requirement act.`);
  }
}

async function planFeedback(key: string, at: Asker): Promise<ItemActReading> {
  const v = await found(readFeedbackAs({ userId: at.userId, agency: 'human' }, at.projectId, key));
  if (!v) return unknown('feedback', key);
  if (!v.can.triage) {
    const untriaged = ['new', 'reopened', 'triaged'].includes(v.phase);
    return untriaged
      ? no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking does not hold feedback.approve, so triaging ${v.key} is not theirs to press; a project admin can.`,
        )
      : no(
          'ITEM_ACT_NOT_FROM_STATE',
          `${v.key} is ${v.phase}, and feedback.triage applies to feedback that is new, reopened or triaged.`,
        );
  }
  return offer({ key: v.key, ref: v.key, title: v.title, from: v.phase });
}

/** The port: what the item's page offers the asker for `act`, or why not. */
export function planItemAct(act: ItemAct, key: string, at: Asker): Promise<ItemActReading> {
  if (act.startsWith('requirement.')) return planRequirement(act, key, at);
  if (act === 'feedback.triage') return planFeedback(key, at);
  if (act.startsWith('workflow.')) return planWorkflow(act, key, at);
  return planRelease(act, key, at);
}
