// What a parked issue waits on, as a room's tracker read hands it to the agent (ISS-877): the open
// question in the asker's words with its options, and who owes the answer. Nothing here decides who
// owes what: the wait is the issue's own standing (`issues/standing.ts`), the question rows are the
// open person questions Needs you reads (`questions/needs-you-read.ts`), and a park asked only in
// the thread is its park view (`issues/park-view.ts`). Plain words stand beside every id, so an
// agent tells a person what they owe without sending them to look it up.

import { isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { issueWaitsOf, loadIssuePark } from '../issues/index.js';
import { type OpenPersonQuestion, readOpenPersonQuestions } from '../questions/index.js';

/** One option of an open question: the id `answer_question` takes, and what it says. */
interface WaitingOption {
  option: string;
  says: string;
  recommended: boolean;
}

/** One open question the issue waits on, as its current round asks it. */
interface WaitingQuestion {
  /** The Forge question, which `ask_owner { forgeQuestion }` and `answer_question` name. */
  id: string;
  /** The question in the asker's words; null where the round is marked sensitive. */
  asks: string | null;
  /** The choices, empty where it is answered in words. */
  options: WaitingOption[];
  /** Answered in words: what would settle it. */
  needed: string | null;
  /** Answered in words: the answer the asker recommends, where they gave one. */
  recommended: string | null;
  askedAt: string;
  /** Why the question text is not here, where it is withheld. */
  withheld?: string;
}

/** What an issue waits on and from whom, read for the room's agent. */
export interface IssueWaiting {
  /** Who owes it, by name: the project's writers where a person does. */
  who: string;
  /** What they owe, lower case after the name ("answer a question", "supply what it asks for"). */
  owes: string;
  /** The open questions it waits on; empty where the park asked only in its thread. */
  questions: WaitingQuestion[];
  /** What the park said it waits on, where it said: the ask itself when no question row carries it. */
  reason: string | null;
}

const SENSITIVE =
  'the question is marked sensitive, so its words are never sent to a model; the person reads it in Forge';

function questionOf(q: OpenPersonQuestion): WaitingQuestion {
  const step: QuestionStep = q.current;
  const choice = isChoiceStep(step);
  return {
    id: q.id,
    asks: step.sensitive ? null : step.prompt,
    options:
      choice && !step.sensitive
        ? step.options.map((o) => ({
            option: o.id,
            says: o.label,
            recommended: o.id === step.recommendedOptionId,
          }))
        : [],
    needed: !choice && !step.sensitive ? step.needed : null,
    recommended: !choice && !step.sensitive ? (step.recommended ?? null) : null,
    askedAt: q.at,
    ...(step.sensitive ? { withheld: SENSITIVE } : {}),
  };
}

/**
 * Each of `rows` that waits on a person's answer — parked at `needs_info`, or holding an open
 * question a person owes — with what it waits on, keyed by issue id. Other rows are absent.
 */
export async function waitingOf(
  projectId: string,
  rows: readonly { id: string; status: string }[],
): Promise<Map<string, IssueWaiting>> {
  const open = await readOpenPersonQuestions(projectId);
  const asked = new Map<string, OpenPersonQuestion[]>();
  for (const q of open) {
    if (!q.issueId) continue;
    asked.set(q.issueId, [...(asked.get(q.issueId) ?? []), q]);
  }
  const waiting = rows.filter((r) => r.status === 'needs_info' || asked.has(r.id));
  if (waiting.length === 0) return new Map();
  // no viewer: the read is the room's, so a person's wait names the people who owe it, never "You"
  const standing = await issueWaitsOf(
    projectId,
    waiting.map((r) => r.id),
    null,
  );
  const out = new Map<string, IssueWaiting>();
  await Promise.all(
    waiting.map(async (r) => {
      const wait = standing.get(r.id)?.standing.waitingOn;
      if (!wait) return;
      const park = await loadIssuePark(r.id);
      out.set(r.id, {
        who: wait.who,
        owes: wait.act,
        questions: (asked.get(r.id) ?? []).map(questionOf),
        reason: park?.threadQuestion?.prompt ?? park?.reason ?? null,
      });
    }),
  );
  return out;
}
