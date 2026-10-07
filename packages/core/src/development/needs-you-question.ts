/**
 * The rows a question attached to nothing owes the viewer on Needs you: a run asked it, no issue,
 * requirement or feedback holds it, and the Agents screen's Questions tab is the only place to answer
 * it. Only whoever may answer is told it waits on them.
 */

import type { NeedsYouEntity } from '@forge/contracts/needs-you';
import { say } from '@forge/contracts/said';
import { type Standing, type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { readDetachedOpenQuestions } from '../questions/index.js';

interface QuestionRow {
  entity: NeedsYouEntity;
  key: string;
  title: string;
  standing: Standing;
  touchedAt: string | null;
}

const owedAnswer: WaitingOn = waitingOn('you', {
  who: say('standing.who.you'),
  act: say('issues.standing.act.answer'),
  rule: say('questions.rule.unheld'),
});

export async function questionRowsOf(
  projectId: string,
  viewer: { mayWrite: boolean },
): Promise<QuestionRow[]> {
  if (!viewer.mayWrite) return [];
  return (await readDetachedOpenQuestions(projectId)).map((q) => ({
    entity: 'question',
    key: q.id,
    title: q.prompt || 'A question a run asked',
    standing: { attentionGroup: 'needs_you', waitingOn: owedAnswer },
    touchedAt: q.at,
  }));
}
