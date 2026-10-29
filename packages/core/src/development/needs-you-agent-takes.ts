// Which of a person's decisions the project's agent may take itself (REQ-68 BC-3): Needs you lists
// only decisions the agent may not take. The agent is the project's master, as the accounts its
// panes write under (`steward-ports.ts:masterAccountsOf`); it may take a decision where one of those
// accounts holds what the decision's approving act asks, read as the act's own route reads it: a
// fixed permission, or a person gate's on or off permission as the project's switch stands
// (`@forge/contracts/person-gates`). A question asked of a person and a reporter's verdict on their
// own report are a person's alone. A decision the agent may take is left out by that reason, never
// dropped, and the master is asked about its item by the steward like any stuck item: the steward
// reads the same rule for a wait's act (`masterTakesWait`, ISS-758).

import {
  type DecisionAct,
  decisionActsOf,
  type NeedsYouDecision,
  type NotDecisionItem,
} from '@forge/contracts/needs-you-decisions';
import type { ProjectPermission } from '@forge/contracts/permissions';
import { type PersonGate, personGatePermission } from '@forge/contracts/person-gates';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { readApprovals } from '../project-config/index.js';
import { masterAccountsOf } from './ports.js';

/** What an act's route asks of its mover: a fixed permission, a person gate, or a person alone. */
type Need = { permission: ProjectPermission } | { gate: PersonGate } | 'person';

const NEED: Readonly<Record<DecisionAct, Need>> = {
  // an agent's token answers only a question asked of a master or a peer (`answer-door.ts`)
  'question.answer': 'person',
  'revision.accept': { gate: 'revisions' },
  'revision.return': { permission: 'requirements.approve' },
  'requirement.agree': { gate: 'agree' },
  'requirement.accept': { gate: 'accept' },
  'requirement.drop': { permission: 'requirements.approve' },
  'requirement.repin': { gate: 'revisions' },
  'requirement.defer': { permission: 'requirements.approve' },
  'issue.admit': { gate: 'admit' },
  'suggestion.accept': { permission: 'suggestions.approve' },
  'suggestion.reject': { permission: 'suggestions.approve' },
  // the reporter says whether their own report is settled
  'feedback.verify': 'person',
  'feedback.reopen': 'person',
  'release.cut': { permission: 'project.admin' },
  'release.decide': { permission: 'releases.approve' },
  'preview.approve': { permission: 'previews.approve' },
  'design.decide': { gate: 'designs' },
  'design.repin': { gate: 'designs' },
  'mockup.accept': { permission: 'mockups.approve' },
  'mockup.return': { permission: 'mockups.approve' },
};

/** A decision the agent takes, left out of a person's list by that reason and opened on its item. */
export const agentTakesItem = (d: NeedsYouDecision): NotDecisionItem => ({
  key: d.opens?.key ?? d.key,
  title: d.title || d.key,
  next: 'the master takes it',
  opens: d.opens,
});

/** The act a decision is taken by: its first answer that does not decline, else its first. */
const takingAct = (d: Pick<NeedsYouDecision, 'answers'>): DecisionAct | null =>
  (d.answers.find((a) => !a.declines) ?? d.answers[0])?.act ?? null;

/** A question stays the person's even where the agent proposed an act beside it (REQ-68 BC-8). */
const personsOnly = (d: Pick<NeedsYouDecision, 'answers'>) =>
  d.answers.some((a) => NEED[a.act] === 'person');

/**
 * The one reading of whether the project's master takes an act (ISS-758), read once for the project
 * and shared by Needs you (`agentTakesOf`) and the steward (`masterTakesWait`), so a row cannot be
 * left to the master by one and to a person by the other. A breakdown's accept follows its own gate,
 * as `suggestions/accept-gate.ts` reads it.
 */
export async function masterTakesOf(
  projectId: string,
): Promise<(act: DecisionAct, topic?: NeedsYouDecision['topic']) => boolean> {
  const accounts = await masterAccountsOf(projectId);
  if (accounts.length === 0) return () => false;
  const approvals = await readApprovals(projectId);
  const held = new Map<ProjectPermission, boolean>();
  const holds = async (permission: ProjectPermission) => {
    if (!held.has(permission)) {
      let any = false;
      for (const id of accounts) {
        if (await can(actorFor(id), permission, projectResource(projectId))) {
          any = true;
          break;
        }
      }
      held.set(permission, any);
    }
    return held.get(permission) === true;
  };
  const permissionOf = (act: DecisionAct, topic: NeedsYouDecision['topic'] | undefined) => {
    const need =
      act === 'suggestion.accept' && topic === 'breakdown'
        ? { gate: 'breakdown' as const }
        : NEED[act];
    if (need === 'person') return null;
    return 'gate' in need ? personGatePermission(approvals, need.gate) : need.permission;
  };
  const permissions = new Set<ProjectPermission>();
  for (const act of Object.keys(NEED) as DecisionAct[]) {
    for (const topic of ['breakdown', 'feedback'] as const) {
      const p = permissionOf(act, topic);
      if (p) permissions.add(p);
    }
  }
  for (const p of permissions) await holds(p);
  return (act, topic) => {
    const p = permissionOf(act, topic);
    return p !== null && held.get(p) === true;
  };
}

/**
 * Whether the project's agent may take each decision, read once for the project. Where every
 * decision is a person's alone, nothing is read.
 */
export async function agentTakesOf(
  projectId: string,
  decisions: readonly Pick<NeedsYouDecision, 'answers'>[],
): Promise<(d: Pick<NeedsYouDecision, 'answers' | 'topic'>) => boolean> {
  if (decisions.every(personsOnly)) return () => false;
  const takes = await masterTakesOf(projectId);
  return (d) => {
    if (personsOnly(d)) return false;
    const act = takingAct(d);
    return act !== null && takes(act, d.topic);
  };
}

/**
 * Whether the project's master takes the act a wait names (ISS-758): every decision act it asks for
 * is one the master's account holds the permission of. An act no person decides, or a person's alone,
 * is not the master's to take here.
 */
export async function masterTakesWait(
  projectId: string,
  act: Parameters<typeof decisionActsOf>[0],
): Promise<boolean> {
  const acts = decisionActsOf(act);
  if (acts === null) return false;
  const takes = await masterTakesOf(projectId);
  return acts.every((a) => takes(a.act, a.topic));
}
