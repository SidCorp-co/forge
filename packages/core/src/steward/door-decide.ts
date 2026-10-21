// The one question the steward asks about a stuck issue (REQ-48 BC-5): its options are the fixed set
// the issue's reading owes (`stewardDecisionsFor`), built here, never spelled by the model, which
// picks only the recommended one and says why in one line. A draft is read against the issue-ready
// check: one that passes is asked open, keep or drop, recommending open; one that does not (no agreed
// requirement fits) is asked link (the steward's candidates, each an agreed requirement and a BC of
// it), requirement or drop. Nothing is asked where the reading names an act somebody already owes,
// where the same question is open, or where a person kept the issue on the standing it reads now:
// each is said to the turn to correct, and is no refusal of the run.

import {
  STEWARD_DECISION_OPTION_IDS,
  STEWARD_DECISIONS,
  STEWARD_LINK_CANDIDATES_MAX,
  type StewardDecision,
  stewardDecisionLabel,
  stewardDecisionsFor,
  stewardLinkLabel,
  stewardLinkOptionId,
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

const candidate = z.strictObject({
  requirement: z
    .string()
    .trim()
    .regex(/^REQ-\d+$/i, 'an agreed requirement, as REQ-n'),
  bc: z
    .string()
    .trim()
    .regex(/^BC-\d+$/i, 'a BC of it, as BC-n'),
});

const decideParams = z.strictObject({
  issue: issueKey.describe('ISS-n: the stuck issue the decision is about'),
  recommended: z
    .enum(STEWARD_DECISIONS)
    .describe(
      'the decision you recommend, as the issue offers: open (a prepared draft), keep, drop, link (your first candidate) or requirement',
    ),
  candidates: z
    .array(candidate)
    .max(STEWARD_LINK_CANDIDATES_MAX)
    .optional()
    .describe(
      'for a draft no agreed requirement fits well: your nearest agreed requirements, best first',
    ),
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

interface ChecklistRead {
  checklists?: { id: string; now?: { complete?: boolean; gaps?: { detail: string }[] } }[];
}

const correct = (text: string) => ({ correct: text });

const ASK_LINE = {
  ready: 'Open it, keep it as a draft, or drop it?',
  unready:
    'No agreed requirement fits it well. Link it to one of these, start a requirement from it, or drop it?',
  live: 'Keep it waiting for a master, or drop it?',
};

interface Option {
  id: string;
  label: string;
  decision: StewardDecision;
}

/** A link candidate checked against the requirement it names: agreed, with that BC current. */
async function linkOption(
  c: z.infer<typeof candidate>,
  ctx: DoorContext,
): Promise<Option | string> {
  const requirement = c.requirement.toUpperCase();
  const bc = c.bc.toUpperCase();
  const read = await send(
    { method: 'GET', path: `/api/projects/${ctx.projectId}/requirements/${requirement}` },
    ctx,
  );
  const req = (read.answer.json ?? {}) as {
    status?: string;
    criteria?: { code: string; body: string }[];
  };
  if (!read.answer.ok || !['agreed', 'accepted'].includes(req.status ?? '')) {
    return `${requirement} is ${req.status ?? 'not a requirement of this project'}: a candidate is agreed or accepted`;
  }
  const hit = (req.criteria ?? []).find((x) => x.code.toUpperCase() === bc);
  if (!hit) return `${requirement} has no current ${bc}`;
  return {
    id: stewardLinkOptionId(requirement, bc),
    label: stewardLinkLabel(requirement, bc, hit.body),
    decision: 'link',
  };
}

/** Whether the draft passes the issue-ready check now, and the gaps where it does not. */
async function readyOf(issueId: string, ctx: DoorContext) {
  const read = await send({ method: 'GET', path: `/api/issues/${issueId}/checklist` }, ctx);
  const ready = ((read.answer.json ?? {}) as ChecklistRead).checklists?.find(
    (c) => c.id === 'issue_ready',
  );
  return { complete: ready?.now?.complete === true, gaps: ready?.now?.gaps ?? [] };
}

export const DECIDE: DoorSpec<z.infer<typeof decideParams>> = {
  name: 'steward_decide',
  describe:
    "Ask whoever decides a stuck issue the one question its reading owes, with Forge's own options. Prepare a draft first (steward_prepare_draft): once it passes the issue-ready check it is asked open, keep or drop, recommending open; where no agreed requirement fits, it is asked link (your candidates, best first), requirement or drop. Unstarted work no master serves is kept waiting or dropped. You pick the recommended one and say why in one line; nobody is ever asked to write a plan or criteria.",
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
    const draft = issue.status === 'draft';
    const ready = draft ? await readyOf(issue.id, ctx) : { complete: false, gaps: [] };
    const offered = stewardDecisionsFor(issue.status, code, ready.complete);
    if (!offered) {
      const wait = standing?.waitingOn;
      return correct(
        `${args.issue} is ${issue.status}${code ? ` and reads ${code}` : ''}: ${wait ? `it waits on ${wait.who} to ${wait.act}, an act already owed` : 'it owes no decision'}. Ask nothing: wake the master (steward_wake_master) or write the note.`,
      );
    }
    if (!offered.includes(args.recommended)) {
      return correct(
        `${args.issue} offers ${offered.join(', ')}; recommend one of them, not ${args.recommended}.${draft && !ready.complete ? ` It does not pass the issue-ready check (${ready.gaps.map((g) => g.detail).join(' ')}): prepare it with steward_prepare_draft, or where no agreed requirement fits, offer your candidates.` : ''}`,
      );
    }
    if (draft && ready.complete && args.recommended !== 'open') {
      return correct(
        `${args.issue} is prepared and passes the issue-ready check: recommend open, and a person keeps or drops it if they decide so.`,
      );
    }
    const options: Option[] = [];
    if (offered.includes('link')) {
      for (const c of args.candidates ?? []) {
        const option = await linkOption(c, ctx);
        if (typeof option === 'string')
          return correct(`candidate ${c.requirement} ${c.bc}: ${option}.`);
        if (!options.some((o) => o.id === option.id)) options.push(option);
      }
      if (args.recommended === 'link' && options.length === 0) {
        return correct('recommending link names at least one candidate, best first.');
      }
    }
    for (const d of offered) {
      if (d !== 'link') {
        options.push({
          id: STEWARD_DECISION_OPTION_IDS[d],
          label: stewardDecisionLabel(d, draft),
          decision: d,
        });
      }
    }
    const recommended =
      args.recommended === 'link'
        ? options.find((o) => o.decision === 'link')
        : options.find((o) => o.decision === args.recommended);
    if (!recommended) return correct(`${args.issue} offers no ${args.recommended} here.`);
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
    const why = standing?.stuck?.reason ?? 'it reads stuck';
    const line = !draft ? ASK_LINE.live : ready.complete ? ASK_LINE.ready : ASK_LINE.unready;
    const prompt = `${args.issue} "${issue.title ?? ''}": ${why} ${line} Recommended: ${recommended.label}, because ${args.why}`;
    const fingerprint = decisionFingerprint(ctx.runId, basis);
    const sent = await send(
      {
        method: 'POST',
        path: '/api/questions',
        body: {
          issueId: issue.id,
          prompt: prompt.slice(0, 2000),
          options: options.map((o) => ({
            id: o.id,
            label: o.label,
            authority: 'writer',
            bindsTo: 'this_call',
            executedBy: 'core',
            fingerprint,
          })),
          recommendedOptionId: recommended.id,
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
        did: `Asked on ${args.issue}: ${options.map((o) => o.id.replace(/^steward\./, '')).join(', ')}, recommending ${recommended.id.replace(/^steward\./, '')} because ${args.why}`,
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
