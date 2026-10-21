// The one question the steward asks about a stuck issue (REQ-48 BC-5): its options are the fixed set
// the issue's reading owes (`stewardDecisionsFor`), built here, never spelled by the model, which
// picks only the recommended one and says why in one line. Nothing is asked where the reading names
// an act somebody already owes, where the same question is open, or where a person kept the issue on
// the standing it reads now: each is said to the turn to correct, and is no refusal of the run.

import {
  STEWARD_DECISION_OPTION_IDS,
  STEWARD_DECISIONS,
  type StewardDecision,
  stewardDecisionLabel,
  stewardDecisionsFor,
} from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { doorName } from './door-call.js';
import { cite, type DoorContext, type DoorSpec, issueKey, send } from './door-kit.js';
import { openStandings } from './ports.js';

/** The fingerprint every option of one decision question carries: the run that asked, and the basis it read. */
export const decisionFingerprint = (runId: string, basis: string) => `steward:${runId}:${basis}`;

/** The run and basis a decision question's fingerprint names, or null for one of another shape. */
export function fingerprintOf(
  fingerprint: string | undefined,
): { runId: string; basis: string } | null {
  const hit = /^steward:([0-9a-f-]{36}):(.+)$/.exec(fingerprint ?? '');
  return hit?.[1] && hit[2] ? { runId: hit[1], basis: hit[2] } : null;
}

interface AskedRow {
  id: string;
  status: string;
  chosen: string | null;
  fingerprint: string | null;
  answered_by: string | null;
}

/** The steward decision questions on an issue, newest first: open ones, and answered keeps. */
async function decisionsAskedOn(issueId: string): Promise<AskedRow[]> {
  const mark = JSON.stringify([{ id: STEWARD_DECISION_OPTION_IDS.drop }]);
  return rowsOf<AskedRow>(
    await db.execute(sql`
      SELECT q.id, q.status,
             q.steps -> -1 ->> 'chosenOptionId' AS chosen,
             q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' AS fingerprint,
             q.steps -> -1 ->> 'answeredBy' AS answered_by
        FROM agent_questions q
       WHERE q.issue_id = ${issueId}
         AND q.status IN ('open', 'answered')
         AND q.steps -> -1 -> 'options' @> ${mark}::jsonb
       ORDER BY q.created_at DESC`),
  );
}

const decideParams = z.strictObject({
  issue: issueKey.describe('ISS-n: the stuck issue the decision is about'),
  recommended: z
    .enum(STEWARD_DECISIONS)
    .describe('the decision you recommend: open, keep or drop, as the issue offers'),
  why: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .describe('one line: why you recommend it, from the records you read'),
});

interface IssueRead {
  id?: string;
  status?: string;
  title?: string;
}

const correct = (text: string) => ({ correct: text });

const ASK_LINE = {
  draft: 'Open it, keep it as a draft, or drop it?',
  live: 'Keep it waiting for a master, or drop it?',
};

export const DECIDE: DoorSpec<z.infer<typeof decideParams>> = {
  name: 'steward_decide',
  describe:
    "Ask whoever decides a stuck issue the one question its reading owes, with Forge's own options: a draft is opened, kept or dropped; unstarted work no master serves is kept waiting or dropped. You pick the recommended one and say why in one line; never recommend writing a plan or criteria first, which its driver writes.",
  params: decideParams,
  write: true,
  async call(args, ctx: DoorContext) {
    const read = await send(
      { method: 'GET', path: `/api/issues/${args.issue}?projectId=${ctx.projectId}` },
      ctx,
    );
    if (!read.answer.ok) return read;
    const issue = (read.answer.json ?? {}) as IssueRead;
    if (!issue.id || !issue.status) return read;
    const standing = (await openStandings(ctx.projectId)).find(
      (s) => s.subject.kind === 'issue' && s.subject.id === issue.id,
    );
    const code = standing?.stuck?.code ?? null;
    const offered = stewardDecisionsFor(issue.status, code);
    if (!offered) {
      const wait = standing?.waitingOn;
      return correct(
        `${args.issue} is ${issue.status}${code ? ` and reads ${code}` : ''}: ${wait ? `it waits on ${wait.who} to ${wait.act}, an act already owed` : 'it owes no decision'}. Ask nothing: wake the master (steward_wake_master) or write the note.`,
      );
    }
    if (!offered.includes(args.recommended)) {
      return correct(
        `${args.issue} offers ${offered.join(', ')}; recommend one of them, not ${args.recommended}.`,
      );
    }
    const basis = standing?.basis ?? 'none';
    const asked = await decisionsAskedOn(issue.id);
    const open = asked.find((q) => q.status === 'open');
    if (open)
      return correct(`question ${open.id} on ${args.issue} already asks it; ask nothing more.`);
    const kept = asked.find(
      (q) =>
        q.chosen === STEWARD_DECISION_OPTION_IDS.keep &&
        fingerprintOf(q.fingerprint ?? undefined)?.basis === basis,
    );
    if (kept) {
      return correct(
        `${args.issue} was kept on the standing it reads now (question ${kept.id}): ask nothing until it moves.`,
      );
    }
    const draft = issue.status === 'draft';
    const label = (d: StewardDecision) => stewardDecisionLabel(d, draft);
    const why = standing?.stuck?.reason ?? 'it reads stuck';
    const prompt = `${args.issue} "${issue.title ?? ''}": ${why} ${draft ? ASK_LINE.draft : ASK_LINE.live} Recommended: ${label(args.recommended)}, because ${args.why}`;
    const fingerprint = decisionFingerprint(ctx.runId, basis);
    const sent = await send(
      {
        method: 'POST',
        path: '/api/questions',
        body: {
          issueId: issue.id,
          prompt: prompt.slice(0, 2000),
          options: offered.map((d) => ({
            id: STEWARD_DECISION_OPTION_IDS[d],
            label: label(d),
            authority: 'writer',
            bindsTo: 'this_call',
            executedBy: 'core',
            fingerprint,
          })),
          recommendedOptionId: STEWARD_DECISION_OPTION_IDS[args.recommended],
          blockerKind: 'human',
        },
      },
      ctx,
    );
    const id = sent.answer.json?.id;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Asked on ${args.issue}: ${offered.join(', ')}, recommending ${args.recommended} because ${args.why}`,
        wrote: cite('question', id),
        undo:
          typeof id === 'string'
            ? {
                door: `POST /api/questions/${id}/void`,
                body: { reason: "A person undid the steward's question, so it needs no answer." },
              }
            : null,
      },
    };
  },
};
