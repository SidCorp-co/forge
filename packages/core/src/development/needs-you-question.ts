/**
 * The rows a question owes the viewer on Needs you where no requirement or feedback list holds it: a
 * run asked it attached to nothing, or asked it on an issue, which no Needs you area lists (REQ-68
 * BC-6), so Approvals is where it is answered and it opens the item it is about (REQ-68 BC-4, BC-9).
 * Only whoever may answer is told it waits on them.
 */

import type { NeedsYouEntity } from '@forge/contracts/needs-you';
import { say } from '@forge/contracts/said';
import { type Standing, type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { readDetachedOpenQuestions, readOpenPersonQuestions } from '../questions/index.js';
import { composedTitle, type RowTitle, writtenTitle } from './row-title.js';

interface QuestionRow extends RowTitle {
  entity: NeedsYouEntity;
  key: string;
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
  const [detached, open] = await Promise.all([
    readDetachedOpenQuestions(projectId),
    readOpenPersonQuestions(projectId),
  ]);
  const onIssues = open
    .filter((q) => q.issueId !== null && q.requirementId === null && q.feedbackId === null)
    .map((q) => ({ id: q.id, prompt: q.current.prompt, at: q.at }));
  return [...detached, ...onIssues].map((q) => ({
    entity: 'question',
    key: q.id,
    // a run's prompt is its words, in a language the question does not keep
    ...(q.prompt ? writtenTitle(q.prompt, null) : composedTitle(say('needsYou.title.question'))),
    standing: { attentionGroup: 'needs_you', waitingOn: owedAnswer },
    touchedAt: q.at,
  }));
}
