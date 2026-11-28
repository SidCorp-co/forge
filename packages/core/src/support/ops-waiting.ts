// What a parked issue waits on, as a room's tracker read hands it to the agent (ISS-877): the open
// question in the asker's words with its options, and who owes the answer. The wait is the issue's own
// standing (`issues/standing.ts`); where that waits on an answer, which names nobody on the issue,
// the people owing it are the project's writers, as the answer route asks. The question rows are the
// open person questions Needs you reads (`questions/needs-you-read.ts`), and a park asked only in
// the thread is its park view (`issues/park-view.ts`). Plain words stand beside every id, so an
// agent tells a person what they owe without sending them to look it up.

import { type SaidKey, say, sayEn } from '@forge/contracts/said';
import { holdersWho, type WaitingOn } from '@forge/contracts/standing';
import { isChoiceStep, type QuestionStep } from '../db/schema-questions.js';
import { issueWaitsOf, listIssues } from '../issues/index.js';
import { peopleOf } from '../lib/people.js';
import { holderNames } from '../permissions/index.js';
import { type OpenPersonQuestion, readOpenPersonQuestions } from '../questions/index.js';
import { NEUTRAL_ASK, parkReasonOf, QUESTION_WORDS_WITHHELD } from './room-read-words.js';
import { NO_PERSON, roomPerson, roomSay } from './room-voice.js';

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
  /** The question in a person's words where one asked it, else that an answer is owed; null where the round is marked sensitive. */
  asks: string | null;
  /** The choices, empty where it is answered in words. */
  options: WaitingOption[];
  /** Answered in words, asked by a person: what would settle it; null where an agent asked. */
  needed: string | null;
  /** Answered in words, asked by a person: the answer they recommend, where they gave one. */
  recommended: string | null;
  askedAt: string;
  /** Why the question's words are not here, where they are withheld. */
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
  /** What it waits on from its kind: that an answer is owed, the other issue by title, else one fixed sentence. Never an agent's words. */
  reason: string | null;
}

const SENSITIVE =
  'the question is marked sensitive, so its words are never sent to a model; the person reads it in Forge';

/**
 * One open question, as a room hears it. Its words stay only where a PERSON asked it (the asking account's
 * kind is `human`): a park's question is minted from the agent's own park text and an agent token's carries
 * an agent's, so those are handed on as owed, with the choices' ids, and their words read in Forge.
 */
export function questionOf(q: OpenPersonQuestion, askedByPerson: boolean): WaitingQuestion {
  const step: QuestionStep = q.current;
  const choice = isChoiceStep(step);
  const said = askedByPerson && !step.sensitive;
  return {
    id: q.id,
    asks: step.sensitive ? null : said ? step.prompt : NEUTRAL_ASK,
    options:
      choice && !step.sensitive
        ? step.options.map((o, i) => ({
            option: o.id,
            says: said ? o.label : `option ${i + 1}`,
            recommended: o.id === step.recommendedOptionId,
          }))
        : [],
    needed: said && !choice ? step.needed : null,
    recommended: said && !choice ? (step.recommended ?? null) : null,
    askedAt: q.at,
    ...(step.sensitive
      ? { withheld: SENSITIVE }
      : said
        ? {}
        : { withheld: QUESTION_WORDS_WITHHELD }),
  };
}

/** What the people who may answer owe, by what the issue waits on (`issues/standing.ts:OWED`). */
const OWES: Readonly<Record<string, SaidKey>> = {
  'issues.standing.who.answer': 'issues.standing.act.answer',
  'issues.standing.who.decision': 'issues.standing.act.decide',
  'issues.standing.who.supply': 'issues.standing.act.supply',
};

/**
 * Who owes a wait and what, for the room's agent to tell them: an issue waiting on an answer names
 * nobody on its own page (REQ-68 BC-6, ISS-687), so the agent is told the people who may give it,
 * the project's writers (the answer route's floor), and the act; any other wait as it is said.
 */
function owedBy(wait: WaitingOn, writers: readonly string[]): { who: string; owes: string } {
  if (wait.kind !== 'answer') {
    return { who: roomPerson(wait.says.who) ?? NO_PERSON, owes: roomSay(wait.says.act) };
  }
  const act = OWES[wait.says.who.key] ?? 'issues.standing.act.answer';
  return { who: sayEn(holdersWho(writers)), owes: sayEn(say(act)) };
}

/** The issue a wait is behind, by the key and title a person knows it by; null where it names none. */
async function behindOf(projectId: string, wait: WaitingOn) {
  if (wait.kind !== 'issue' || !wait.ref) return null;
  const found = await listIssues(
    projectId,
    { key: wait.ref },
    { sort: 'updatedAt:desc', limit: 1, offset: 0 },
  );
  return { title: found.ok ? (found.rows[0]?.title ?? null) : null };
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
  const people = await peopleOf(open.map((q) => q.askedBy));
  const waiting = rows.filter((r) => r.status === 'needs_info' || asked.has(r.id));
  if (waiting.length === 0) return new Map();
  // no viewer: the read is the room's, so a person's wait names the people who owe it, never "You"
  const [standing, writers] = await Promise.all([
    issueWaitsOf(
      projectId,
      waiting.map((r) => r.id),
    ),
    holderNames('project.write', projectId),
  ]);
  const out = new Map<string, IssueWaiting>();
  await Promise.all(
    waiting.map(async (r) => {
      const wait = standing.get(r.id)?.standing.waitingOn;
      if (!wait) return;
      out.set(r.id, {
        ...owedBy(wait, writers),
        questions: (asked.get(r.id) ?? []).map((q) =>
          questionOf(q, q.askedBy !== null && people.get(q.askedBy)?.kind === 'human'),
        ),
        reason: parkReasonOf(wait.kind, await behindOf(projectId, wait)),
      });
    }),
  );
  return out;
}
