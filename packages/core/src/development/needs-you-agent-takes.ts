// Which of a person's decisions the project's master takes itself (REQ-68 BC-3): Needs you lists only
// decisions the agent may not take. Who takes each is the one rule's (`@forge/contracts/who-owes:whoOwes`,
// ISS-1058): a routine act is the master's, read with the project's policy (`project-config:readOwedPolicy`)
// and, for a release's decision, what the release carries that cannot be undone. Whether a master
// stands now is not asked: a project owing a routine act gets a master placed for it, and until then
// the act waits on that master, never on a person (round 1 read the master's accounts, so a project
// whose pane was gone left every routine act on its owner). A decision the master takes is left out by
// that reason, never dropped, and the steward asks the master about its item by the same rule
// (`masterTakesWait`, ISS-758).

import {
  type DecisionAct,
  decisionActsOf,
  type NeedsYouDecision,
  type NotDecisionItem,
} from '@forge/contracts/needs-you-decisions';
import { OWED_ACTS, type OwedContent, owedActOfDecision, whoOwes } from '@forge/contracts/who-owes';
import { readOwedPolicy } from '../project-config/index.js';

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

type Taker = (
  act: DecisionAct,
  topic?: NeedsYouDecision['topic'],
  content?: OwedContent | null,
) => boolean;

/**
 * The one reading of whether the project's master takes an act (ISS-758, ISS-1058), read once for the
 * project and shared by Needs you (`agentTakesOf`) and the steward (`masterTakesWait`), so a row
 * cannot be left to the master by one and to a person by the other.
 */
export async function masterTakesOf(projectId: string): Promise<Taker> {
  const policy = await readOwedPolicy(projectId);
  return (act, topic, content) =>
    whoOwes(owedActOfDecision(act, topic), policy, content).by === 'master';
}

/**
 * Whether the project's master takes each decision, read once for the project. A decision any of
 * whose answers is serious by its kind (a question's answer) stays the person's even where the agent
 * proposed an act beside it (REQ-68 BC-8). `contentOf` says what a decision's record carries that
 * cannot be undone (a release's), which turns a routine act serious.
 */
export async function agentTakesOf(
  projectId: string,
  contentOf: (d: Pick<NeedsYouDecision, 'opens'>) => OwedContent | null = () => null,
): Promise<(d: Pick<NeedsYouDecision, 'answers' | 'topic' | 'opens'>) => boolean> {
  const takes = await masterTakesOf(projectId);
  return (d) => {
    if (d.answers.some((a) => OWED_ACTS[owedActOfDecision(a.act, d.topic)].serious)) return false;
    const act = takingAct(d);
    return act !== null && takes(act, d.topic, contentOf(d));
  };
}

/**
 * Whether the project's master takes the act a wait names (ISS-758): every decision act it asks for
 * is the master's by the one rule. An act no person decides is not the master's to take here.
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
