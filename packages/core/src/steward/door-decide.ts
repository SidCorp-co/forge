// The one question the steward asks about a stuck item (REQ-48 BC-5): its options are the fixed set
// the item's reading owes, built here, never spelled by the model, which picks only the recommended
// one and says why in one line. An issue draft is read against the issue-ready check: one that passes
// is asked open, keep or drop, recommending open; one that does not (no agreed requirement fits) is
// asked link (the steward's candidates, each an agreed requirement and a BC of it), requirement or
// drop; either may be asked merge into the live issue it repeats. A draft requirement is asked merge,
// drop or keep, a draft revision of an agreed one withdraw or keep; a feedback item nobody triages is
// asked keep or decline, a fix nobody verifies verify, reopen or keep. Nothing is asked where the
// reading names an act somebody already owes, where the same question is open, or where a person
// kept the item on the standing it reads now: each is said to the turn to correct, and is no refusal
// of the run.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import {
  STEWARD_DECISION_OPTION_IDS,
  STEWARD_DECISIONS,
  STEWARD_LINK_CANDIDATES_MAX,
  type StewardDecision,
  type StewardDecisionSubject,
  stewardDecisionLabel,
  stewardDecisionsFor,
  stewardFeedbackDecisionsFor,
  stewardLinkLabel,
  stewardLinkOptionId,
  stewardMergeLabel,
  stewardMergeOptionId,
  stewardRequirementDecisionsFor,
} from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { fingerprintOf } from './decision-ask.js';
import { doorName } from './door-call.js';
import { cite, type DoorContext, type DoorSpec, key, send } from './door-kit.js';
import { openStandings } from './ports.js';

export { decisionFingerprint, fingerprintOf } from './decision-ask.js';

interface AskedRow {
  id: string;
  status: string;
  chosen: string | null;
  chosen_label: string | null;
  answered_at: string | null;
  fingerprint: string | null;
}

/**
 * Every question on the item, of every kind, newest first: the steward's own, a park's, a run's, and
 * the merge-or-drop question Forge asked on a draft before the steward took that job over. A
 * person's answer on any of them is read before the steward asks again (ISS-134 and ISS-284).
 */
async function questionsAskedOn(subject: {
  kind: StewardDecisionSubject;
  id: string;
}): Promise<AskedRow[]> {
  const on =
    subject.kind === 'issue'
      ? sql`q.issue_id = ${subject.id}`
      : subject.kind === 'requirement'
        ? sql`q.requirement_id = ${subject.id}`
        : sql`q.about ->> 'kind' = 'feedback' AND q.about ->> 'feedbackId' = ${subject.id}`;
  return rowsOf<AskedRow>(
    await db.execute(sql`
      SELECT q.id, q.status,
             q.steps -> -1 ->> 'chosenOptionId' AS chosen,
             (SELECT o ->> 'label' FROM jsonb_array_elements(q.steps -> -1 -> 'options') o
               WHERE o ->> 'id' = q.steps -> -1 ->> 'chosenOptionId' LIMIT 1) AS chosen_label,
             q.steps -> -1 ->> 'answeredAt' AS answered_at,
             q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' AS fingerprint
        FROM agent_questions q
       WHERE ${on}
         AND q.status IN ('open', 'answered')
       ORDER BY q.created_at DESC`),
  );
}

/** Whether an answer chose to keep the item as it is, whichever question asked it. */
export function choseKeep(chosen: string | null, label: string | null): boolean {
  if (!chosen) return false;
  return /(^|[._:-])keep([._:-]|$)/i.test(chosen) || /^\s*keep\b/i.test(label ?? '');
}

/**
 * The person's keep that still holds on the standing read now: the steward's own on this basis, or
 * a keep of any other question answered since the item came to read as it does.
 */
function keptNow(asked: readonly AskedRow[], basis: string, since: string | null) {
  return asked.find((q) => {
    if (q.status !== 'answered' || !choseKeep(q.chosen, q.chosen_label)) return false;
    const own = fingerprintOf(q.fingerprint ?? undefined);
    if (own && q.chosen === STEWARD_DECISION_OPTION_IDS.keep) return own.basis === basis;
    if (!since || !q.answered_at) return true;
    return new Date(q.answered_at).getTime() >= new Date(since).getTime();
  });
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

const itemKey = key.regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/, 'an item key: ISS-n, REQ-n or FB-n');

const decideParams = z.strictObject({
  about: itemKey.describe(
    'the stuck item the decision is about: an issue key (ISS-n), REQ-n or FB-n',
  ),
  recommended: z
    .enum(STEWARD_DECISIONS)
    .describe(
      'the decision you recommend, as the item offers: an issue open, keep, drop, link (your first candidate), requirement or merge; a requirement merge, drop, keep or withdraw; a feedback item keep, drop (decline), verify or reopen',
    ),
  candidates: z
    .array(candidate)
    .max(STEWARD_LINK_CANDIDATES_MAX)
    .optional()
    .describe(
      'for a draft issue no agreed requirement fits well: your nearest agreed requirements, best first',
    ),
  into: itemKey
    .optional()
    .describe(
      'for merge: the live item of the same kind it repeats, an issue for an issue and a requirement for a requirement',
    ),
  why: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .describe('one line: why you recommend it, from the records you read'),
});
type DecideArgs = z.infer<typeof decideParams>;

interface Option {
  id: string;
  label: string;
  decision: StewardDecision;
}

/** What one kind of item offers, read through its own door: the set, the item, and how it is asked. */
interface Offer {
  subject: { kind: StewardDecisionSubject; id: string };
  title: string;
  /** Its status as its own read says it. */
  state: string;
  offered: readonly StewardDecision[];
  /** An issue or a requirement at draft. */
  draft: boolean;
  line: string;
  /** Said after the set where the recommended decision is not in it. */
  hint?: string;
  /** Said to the turn where the recommended decision is in the set but not what the item reads. */
  misfit?: string;
}

const correct = (text: string) => ({ correct: text });

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

const LIVE_REQUIREMENT_ENDED = ['dropped', 'deferred'];

/** A merge target checked: a live item of the draft's own kind, not the draft itself. */
async function mergeOption(
  into: string,
  offer: Offer,
  about: string,
  ctx: DoorContext,
): Promise<Option | string> {
  const target = into.toUpperCase();
  if (target === about) return `${about} cannot be merged into itself`;
  if (offer.subject.kind === 'requirement') {
    if (!/^REQ-\d+$/.test(target)) return `${about} merges only into a requirement, not ${target}`;
    const read = await send(
      { method: 'GET', path: `/api/projects/${ctx.projectId}/requirements/${target}` },
      ctx,
    );
    const req = (read.answer.json ?? {}) as { status?: string; title?: string };
    if (!read.answer.ok || LIVE_REQUIREMENT_ENDED.includes(req.status ?? 'dropped')) {
      return `${target} is ${req.status ?? 'not a requirement of this project'}: a merge goes into a live requirement`;
    }
    return {
      id: stewardMergeOptionId(target),
      label: stewardMergeLabel(target, req.title ?? ''),
      decision: 'merge',
    };
  }
  if (/^(REQ|FB)-\d+$/.test(target)) return `${about} merges only into an issue, not ${target}`;
  const read = await send(
    { method: 'GET', path: `/api/issues/${target}?projectId=${ctx.projectId}` },
    ctx,
  );
  const issue = (read.answer.json ?? {}) as { status?: string; title?: string };
  if (
    !read.answer.ok ||
    (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status ?? 'dropped')
  ) {
    return `${target} is ${issue.status ?? 'not an issue of this project'}: a merge goes into a live issue`;
  }
  return {
    id: stewardMergeOptionId(target),
    label: stewardMergeLabel(target, issue.title ?? ''),
    decision: 'merge',
  };
}

interface ChecklistRead {
  checklists?: { id: string; now?: { complete?: boolean; gaps?: { detail: string }[] } }[];
}

/** Whether the draft passes the issue-ready check now, and the gaps where it does not. */
async function readyOf(issueId: string, ctx: DoorContext) {
  const read = await send({ method: 'GET', path: `/api/issues/${issueId}/checklist` }, ctx);
  const ready = ((read.answer.json ?? {}) as ChecklistRead).checklists?.find(
    (c) => c.id === 'issue_ready',
  );
  return { complete: ready?.now?.complete === true, gaps: ready?.now?.gaps ?? [] };
}

const ISSUE_LINE = {
  ready: 'Open it, keep it as a draft, or drop it?',
  unready:
    'No agreed requirement fits it well. Link it to one of these, start a requirement from it, or drop it?',
  live: 'Keep it waiting for a master, or drop it?',
};

type Read = Awaited<ReturnType<typeof send>>;

async function issueOffer(args: DecideArgs, ctx: DoorContext): Promise<Offer | Read> {
  const read = await send(
    { method: 'GET', path: `/api/issues/${args.about}?projectId=${ctx.projectId}` },
    ctx,
  );
  const issue = (read.answer.json ?? {}) as { id?: string; status?: string; title?: string };
  if (!read.answer.ok || !issue.id || !issue.status) return read;
  const standing = await standingOf(ctx, 'issue', issue.id);
  const draft = issue.status === 'draft';
  const ready = draft ? await readyOf(issue.id, ctx) : { complete: false, gaps: [] };
  const offered = stewardDecisionsFor(issue.status, standing?.stuck?.code ?? null, ready.complete);
  const misfit =
    draft && ready.complete && !['open', 'merge'].includes(args.recommended)
      ? `${args.about} is prepared and passes the issue-ready check: recommend open, or merge where it repeats a live issue; a person keeps or drops it if they decide so.`
      : undefined;
  const hint =
    draft && !ready.complete
      ? ` It does not pass the issue-ready check (${ready.gaps.map((g) => g.detail).join(' ')}): prepare it with steward_prepare_draft, or where no agreed requirement fits, offer your candidates.`
      : undefined;
  return {
    subject: { kind: 'issue', id: issue.id },
    title: issue.title ?? '',
    state: issue.status,
    offered: offered ?? [],
    draft,
    line: !draft ? ISSUE_LINE.live : ready.complete ? ISSUE_LINE.ready : ISSUE_LINE.unready,
    ...(hint ? { hint } : {}),
    ...(misfit ? { misfit } : {}),
  };
}

async function requirementOffer(args: DecideArgs, ctx: DoorContext): Promise<Offer | Read> {
  const read = await send(
    { method: 'GET', path: `/api/projects/${ctx.projectId}/requirements/${args.about}` },
    ctx,
  );
  const req = (read.answer.json ?? {}) as {
    id?: string;
    status?: string;
    title?: string;
    currentRevision?: number | null;
    standing?: { facts?: { draftRevision?: number | null; proposedRevision?: number | null } };
  };
  if (!read.answer.ok || !req.id || !req.status) return read;
  const facts = req.standing?.facts ?? {};
  const offered = stewardRequirementDecisionsFor({
    status: req.status,
    draftRevision: (facts.draftRevision ?? null) !== null,
    proposedRevision: (facts.proposedRevision ?? null) !== null,
    head: req.currentRevision ?? null,
  });
  const draft = req.status === 'draft';
  return {
    subject: { kind: 'requirement', id: req.id },
    title: req.title ?? '',
    state: req.status,
    offered: offered ?? [],
    draft,
    line: draft
      ? 'Merge it into the requirement it repeats, drop it, or keep it as a draft?'
      : 'Withdraw its draft revision, or keep it?',
  };
}

async function feedbackOffer(args: DecideArgs, ctx: DoorContext): Promise<Offer | Read> {
  const read = await send(
    { method: 'GET', path: `/api/projects/${ctx.projectId}/feedback/${args.about}` },
    ctx,
  );
  const json = (read.answer.json ?? {}) as {
    feedback?: { id?: string; title?: string; status?: string };
  };
  const item = json.feedback ?? {};
  if (!read.answer.ok || !item.id) return read;
  const standing = await standingOf(ctx, 'feedback', item.id);
  const act = standing?.waitingOn.says?.act.key ?? '';
  const offered = standing?.stuck ? stewardFeedbackDecisionsFor(act) : null;
  return {
    subject: { kind: 'feedback', id: item.id },
    title: item.title ?? '',
    state: item.status ?? 'open',
    offered: offered ?? [],
    draft: false,
    line: offered?.includes('verify')
      ? 'Verify the fix on its reporter’s behalf, reopen it, or keep it waiting?'
      : 'Keep it waiting for triage, or decline it?',
  };
}

async function standingOf(ctx: DoorContext, kind: StewardDecisionSubject, id: string) {
  return (await openStandings(ctx.projectId)).find(
    (s) => s.subject.kind === kind && s.subject.id === id,
  );
}

const kindOf = (about: string): StewardDecisionSubject =>
  /^REQ-\d+$/i.test(about) ? 'requirement' : /^FB-\d+$/i.test(about) ? 'feedback' : 'issue';

/** The options the offer holds for these args, or what the turn must correct. */
async function optionsOf(
  args: DecideArgs,
  offer: Offer,
  ctx: DoorContext,
): Promise<Option[] | string> {
  const options: Option[] = [];
  if (offer.offered.includes('link')) {
    for (const c of args.candidates ?? []) {
      const option = await linkOption(c, ctx);
      if (typeof option === 'string') return `candidate ${c.requirement} ${c.bc}: ${option}.`;
      if (!options.some((o) => o.id === option.id)) options.push(option);
    }
    if (args.recommended === 'link' && options.length === 0) {
      return 'recommending link names at least one candidate, best first.';
    }
  }
  if (offer.offered.includes('merge') && args.into) {
    const option = await mergeOption(args.into, offer, args.about.toUpperCase(), ctx);
    if (typeof option === 'string') return `${option}.`;
    options.push(option);
  }
  if (args.recommended === 'merge' && !args.into) {
    return 'recommending merge names the live item it repeats in `into`.';
  }
  for (const d of offer.offered) {
    if (d === 'link' || d === 'merge') continue;
    options.push({
      id: STEWARD_DECISION_OPTION_IDS[d],
      label: stewardDecisionLabel(d, { kind: offer.subject.kind, draft: offer.draft }),
      decision: d,
    });
  }
  return options;
}

export const DECIDE: DoorSpec<DecideArgs> = {
  name: 'steward_decide',
  describe:
    "Ask whoever decides a stuck item (an issue, REQ-n or FB-n) the one question its reading owes, with Forge's own options. An issue draft is prepared first (steward_prepare_draft): once it passes the issue-ready check it is asked open, keep or drop, recommending open; where no agreed requirement fits, it is asked link (your candidates, best first), requirement or drop; a draft repeating a live issue may be asked merge (`into`). Unstarted work no master serves is kept waiting or dropped. A draft requirement its author does not finish is asked merge (`into` the live requirement it repeats), drop or keep; a draft revision of an agreed one withdraw or keep. A feedback item nobody triages is asked keep or drop (decline); a fix nobody verifies verify, reopen or keep. You pick the recommended one and say why in one line; nobody is ever asked to write a plan or criteria.",
  params: decideParams,
  write: true,
  async call(args, ctx: DoorContext) {
    const about = args.about.toUpperCase();
    const kind = kindOf(about);
    const read =
      kind === 'issue'
        ? await issueOffer({ ...args, about }, ctx)
        : kind === 'requirement'
          ? await requirementOffer({ ...args, about }, ctx)
          : await feedbackOffer({ ...args, about }, ctx);
    if (!('offered' in read)) return read;
    const offer = read;
    const standing = await standingOf(ctx, offer.subject.kind, offer.subject.id);
    const code = standing?.stuck?.code ?? null;
    if (offer.offered.length === 0) {
      const wait = standing?.waitingOn;
      return correct(
        `${about} is ${offer.state}${code ? ` and reads ${code}` : ''}: ${wait ? `it waits on ${wait.who} to ${wait.act}, an act already owed` : 'it owes no decision'}. Ask nothing: wake the master (steward_wake_master) or write the note.`,
      );
    }
    if (!offer.offered.includes(args.recommended)) {
      return correct(
        `${about} offers ${offer.offered.join(', ')}; recommend one of them, not ${args.recommended}.${offer.hint ?? ''}`,
      );
    }
    if (offer.misfit) return correct(offer.misfit);
    const options = await optionsOf({ ...args, about }, offer, ctx);
    if (typeof options === 'string') return correct(options);
    const recommended = options.find((o) =>
      args.recommended === 'link' || args.recommended === 'merge'
        ? o.decision === args.recommended
        : o.id === STEWARD_DECISION_OPTION_IDS[args.recommended],
    );
    if (!recommended) return correct(`${about} offers no ${args.recommended} here.`);
    const basis = standing?.basis ?? 'none';
    const asked = await questionsAskedOn(offer.subject);
    const open = asked.find((q) => q.status === 'open');
    if (open) return correct(`question ${open.id} on ${about} already asks it; ask nothing more.`);
    const kept = keptNow(asked, basis, standing?.since ?? null);
    if (kept) {
      return correct(
        `${about} was kept on the standing it reads now (question ${kept.id}, answered ${kept.chosen_label ?? kept.chosen}): ask nothing until it moves.`,
      );
    }
    const why = standing?.stuck?.reason ?? 'it reads stuck';
    const prompt = `${about} "${offer.title}": ${why} ${offer.line} Recommended: ${recommended.label}, because ${args.why}`;
    const sent = await send(
      {
        method: 'POST',
        path: `/api/projects/${ctx.projectId}/steward-runs/${ctx.runId}/decisions`,
        body: {
          about,
          prompt: prompt.slice(0, 2000),
          options: options.map((o) => ({ id: o.id, label: o.label })),
          recommendedOptionId: recommended.id,
          basis,
        },
      },
      ctx,
    );
    const id = sent.answer.json?.id;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Asked on ${about}: ${options.map((o) => o.id.replace(/^steward\./, '')).join(', ')}, recommending ${recommended.id.replace(/^steward\./, '')} because ${args.why}`,
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
