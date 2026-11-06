// What each item kind's page offers a person, read as that person when the chat puts an act in a set
// (REQ-69 BC-3, BC-4, BC-6): one adapter per kind behind one port, `planItemAct`. Each reads the item
// through its module's own read, as the page does, and answers the act its door will be called with
// (the revision, the issues a cut takes), or the refusal naming why the act is not one the item's
// state allows or the person may take. The act itself goes through the item's own door
// (`item-act-doors.ts`), which checks both again on the person's word; this read is so a set is never
// put for an act that could only fail.

import {
  ITEM_ACTS,
  type ItemAct,
  type ItemActAsk,
  type ItemActPlan,
  type ItemActRefusalCode,
  itemActKind,
} from '@forge/contracts/item-acts';
import { HTTPException } from 'hono/http-exception';
import { personIssueActsOf, detailAs as readFeedbackAs } from '../../feedback/index.js';
import { isRefusal } from '../../lib/refusal.js';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { readRelease } from '../../release-batch/index.js';
import { readRequirementAs } from '../../requirements/index.js';
import { readDesignAs } from '../../workflows/index.js';
import { workflowIdOf } from './item-act-state.js';

/** The person the act is read and made as. */
export interface Asker {
  projectId: string;
  userId: string;
}

export type ItemActReading =
  | { ok: true; key: string; plan: ItemActPlan; said: string }
  | { ok: false; code: ItemActRefusalCode; why: string };

const no = (code: ItemActRefusalCode, why: string): ItemActReading => ({ ok: false, code, why });

const asHuman = (at: Asker) => ({ userId: at.userId, agency: 'human' as const });

/** A read that answered "no such item here" (404, or a key of the wrong shape); anything else is thrown on. */
async function found<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof HTTPException && (err.status === 404 || err.status === 400)) return null;
    if (isRefusal(err) && err.refusals.some((r) => /NOT_FOUND|UNKNOWN|SHAPE/.test(r.code)))
      return null;
    throw err;
  }
}

const unknown = (kind: string, key: string) =>
  no('ITEM_ACT_UNKNOWN_ITEM', `${key} names no ${kind} in this project.`);

/** What making the act records and where, in one clause the reply restates (BC-4). */
function saidOf(act: ItemAct, key: string, plan: ItemActPlan): string {
  const r = plan.revision ? ` revision ${plan.revision}` : '';
  const words: Record<ItemAct, string> = {
    'requirement.propose': `proposes ${key}${r} to its signer`,
    'requirement.agree': `agrees ${key}${r}, recording the reason on its baseline`,
    'requirement.accept': `accepts the proposed${r} on ${key}, recording the reason`,
    'requirement.return': `returns the proposed${r} on ${key} to a draft, with the reason`,
    'requirement.defer': `defers ${key}, recording the reason on its history`,
    'requirement.undefer': `brings ${key} back from deferred, recording the reason`,
    'requirement.drop': `drops ${key}, recording the reason on its history`,
    'requirement.accept_delivery': `accepts the delivery of ${key}${r}`,
    'feedback.triage': `triages ${key} to ${plan.triage?.route ?? 'its route'}, recorded on its triage history`,
    'workflow.propose': `proposes ${key}'s design${r} to its approver`,
    'workflow.approve': `approves ${key}'s design${r}`,
    'workflow.return': `returns ${key}'s design${r} with the reason`,
    'release.cut': `cuts release ${key} with ${plan.issueIds?.length ?? 0} issue(s)`,
    'release.approve': `approves release ${key} to ship`,
    'release.return': `returns release ${key} with the reason`,
  };
  return words[act];
}

const notSigner = (key: string, act: string) =>
  no(
    'ITEM_ACT_FORBIDDEN',
    `the person asking does not hold the sign-off on this project's requirements, so ${act} on ${key} is not theirs to make; a project admin can.`,
  );

// the page offers defer while the requirement is not yet in delivery, and drop until it ends
const DEFERRABLE = new Set(['draft', 'agreed']);
const DROPPABLE = new Set(['draft', 'agreed', 'in_delivery', 'deferred']);

type Plan = Omit<ItemActPlan, 'act'>;

async function planRequirement(
  act: ItemAct,
  key: string,
  at: Asker,
): Promise<ItemActReading | Plan> {
  const d = await found(readRequirementAs(asHuman(at), at.projectId, key));
  if (!d) return unknown('requirement', key);
  const base = { ref: d.key, from: d.status };
  const draft = d.revisions.find((r) => r.state === 'draft');
  const proposed = d.revisions.find((r) => r.state === 'proposed');
  const head = d.revisions.find((r) => r.state === 'current');
  const state = (allows: string) =>
    no('ITEM_ACT_NOT_FROM_STATE', `${d.key} is ${d.status}, and ${act} applies to ${allows}.`);
  switch (act) {
    case 'requirement.propose': {
      if (!draft) return state('a requirement with a draft revision not yet proposed');
      const writes = await can(actorFor(at.userId), 'project.write', projectResource(at.projectId));
      if (!writes)
        return no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking does not hold project.write, so proposing ${d.key} is not theirs to make.`,
        );
      return { ...base, revision: draft.revision };
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
      return { ...base, revision: head.revision };
    }
    case 'requirement.accept':
    case 'requirement.return':
      if (!proposed) return state('a requirement with a proposed revision');
      if (!d.canSignOff) return notSigner(d.key, act);
      return { ...base, revision: proposed.revision };
    case 'requirement.defer':
      if (!DEFERRABLE.has(d.status)) return state('a draft or agreed requirement');
      return d.canSignOff ? base : notSigner(d.key, act);
    case 'requirement.undefer':
      if (d.status !== 'deferred') return state('a deferred requirement');
      return d.canSignOff ? base : notSigner(d.key, act);
    case 'requirement.drop':
      if (!DROPPABLE.has(d.status))
        return state('a requirement that is not delivered, dropped or refused');
      return d.canSignOff ? base : notSigner(d.key, act);
    case 'requirement.accept_delivery':
      if (d.status !== 'delivered' || !head) return state('a delivered requirement');
      if (!d.canAccept)
        return no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking may not accept ${d.key}'s delivery on this project; whoever holds the acceptance can.`,
        );
      return { ...base, revision: head.revision };
    default:
      return no('ITEM_ACT_INVALID', `${act} is not a requirement act.`);
  }
}

async function planFeedback(key: string, at: Asker): Promise<ItemActReading | Plan> {
  const v = await found(readFeedbackAs(asHuman(at), at.projectId, key));
  if (!v) return unknown('feedback', key);
  if (!v.can.triage) {
    const untriaged = ['new', 'reopened', 'triaged'].includes(v.phase);
    return untriaged
      ? no(
          'ITEM_ACT_FORBIDDEN',
          `the person asking may not triage ${v.key} on this project; whoever holds feedback.approve can.`,
        )
      : no(
          'ITEM_ACT_NOT_FROM_STATE',
          `${v.key} is ${v.phase}, and feedback.triage applies to feedback that is new, reopened or triaged.`,
        );
  }
  return { ref: v.key, from: v.phase };
}

async function planWorkflow(act: ItemAct, key: string, at: Asker): Promise<ItemActReading | Plan> {
  const id = await workflowIdOf(at.projectId, key);
  const d = id ? await found(readDesignAs(asHuman(at), at.projectId, id)) : null;
  if (!d) return unknown('workflow', key);
  const status = d.status ?? 'draft';
  const base = { ref: d.workflowId, from: status };
  if (act === 'workflow.propose') {
    if (status !== 'draft')
      return no(
        'ITEM_ACT_NOT_FROM_STATE',
        `${d.flow}'s design is ${status}, and workflow.propose applies to a draft design; a change is proposed by writing it on the design page.`,
      );
    const writes = await can(
      actorFor(at.userId),
      'workflow-designs.write',
      projectResource(at.projectId),
    );
    if (!writes)
      return no(
        'ITEM_ACT_FORBIDDEN',
        `the person asking does not hold workflow-designs.write, so proposing ${d.flow} is not theirs to make.`,
      );
    return { ...base, revision: d.revision };
  }
  if (d.proposedRevision === null)
    return no(
      'ITEM_ACT_NOT_FROM_STATE',
      `${d.flow}'s design is ${status}, and ${act} applies to a design awaiting its approver.`,
    );
  if (!d.canDecide)
    return no(
      'ITEM_ACT_FORBIDDEN',
      `the person asking may not decide ${d.flow}'s design on this project; its approver (${d.approver}) can.`,
    );
  return { ...base, revision: d.proposedRevision };
}

async function planRelease(act: ItemAct, key: string, at: Asker): Promise<ItemActReading | Plan> {
  const isAdmin = await can(actorFor(at.userId), 'project.admin', projectResource(at.projectId));
  const mayApprove = await can(
    actorFor(at.userId),
    'releases.approve',
    projectResource(at.projectId),
  );
  const viewer = { ...asHuman(at), isAdmin, mayApprove };
  const r = await found(readRelease(at.projectId, key, viewer));
  if (!r) return unknown('release', key);
  const base = { ref: r.version, from: r.state };
  if (act === 'release.cut') {
    if (!r.can.cut && !r.can.split)
      return no(
        isAdmin ? 'ITEM_ACT_NOT_FROM_STATE' : 'ITEM_ACT_FORBIDDEN',
        isAdmin
          ? `${r.version} is ${r.state} and cannot be cut now; its page names what stands in the way.`
          : `the person asking is not a project admin, so cutting ${r.version} is not theirs to make.`,
      );
    // the act RELEASE_ROSTER_OVERSIZE names: core chose the oldest merged issues one release carries
    const issueIds = r.can.split && r.split ? r.split.issueIds : r.issues.map((i) => i.id);
    return { ...base, issueIds };
  }
  if (!r.can.decide)
    return no(
      mayApprove ? 'ITEM_ACT_NOT_FROM_STATE' : 'ITEM_ACT_FORBIDDEN',
      mayApprove
        ? `${r.version} is ${r.state}, and ${act} applies to a release awaiting approval.`
        : `the person asking does not hold releases.approve, so deciding ${r.version} is not theirs to make.`,
    );
  return base;
}

/** The ask's shape against its act: a reason where one is owed, a triage only on a triage. */
function shapeRefusal(ask: ItemActAsk): ItemActReading | null {
  const rule = ITEM_ACTS[ask.act].reason;
  if (rule === 'required' && !ask.reason)
    return no(
      'ITEM_ACT_REASON_REQUIRED',
      `${ask.act} carries the person's reason, as its page asks; ask them why, and pass their words as reason.`,
    );
  if (rule === 'none' && ask.reason)
    return no('ITEM_ACT_INVALID', `${ask.act} takes no reason; leave reason out.`);
  if (ask.act !== 'feedback.triage' && ask.triage)
    return no(
      'ITEM_ACT_INVALID',
      `triage belongs to feedback.triage only; leave it out of ${ask.act}.`,
    );
  if (ask.act === 'feedback.triage') {
    if (!ask.triage?.route)
      return no('ITEM_ACT_INVALID', 'feedback.triage needs triage.route, where the item goes.');
    // the Feedback route's own gate on a person's triage (REQ-68 BC-6), met here as the person
    const named = personIssueActsOf(ask.triage);
    if (named.length > 0)
      return no(
        'ITEM_ACT_FILES_ISSUE',
        `a chat names or titles no issue (REQ-69 BC-7): ${named.map((r) => `${r.code}: ${r.detail}`).join('; ')}.`,
      );
  }
  return null;
}

/** The port: the act the item's page would make for the asker, as core will make it, or why not. */
export async function planItemAct(ask: ItemActAsk, at: Asker): Promise<ItemActReading> {
  const shape = shapeRefusal(ask);
  if (shape) return shape;
  const kind = itemActKind(ask.act);
  const read =
    kind === 'requirement'
      ? await planRequirement(ask.act, ask.key, at)
      : kind === 'feedback'
        ? await planFeedback(ask.key, at)
        : kind === 'workflow'
          ? await planWorkflow(ask.act, ask.key, at)
          : await planRelease(ask.act, ask.key, at);
  if ('ok' in read) return read;
  const plan: ItemActPlan = {
    act: ask.act,
    ...read,
    ...(ask.triage ? { triage: ask.triage } : {}),
  };
  // a workflow is read by its flow, which is what the person names; its door takes the uuid
  const key = kind === 'workflow' ? ask.key : read.ref;
  return { ok: true, key, plan, said: saidOf(ask.act, key, plan) };
}
