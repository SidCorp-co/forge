// The one question the steward asks about a stuck item (REQ-48 BC-5): its options are the fixed set
// the item's reading owes, built here, never spelled by the model, which picks only the recommended
// one and says why in one line. An issue draft is read against the issue-ready check: one that passes
// is asked open, keep or drop, recommending open; one that does not (no agreed requirement fits) is
// asked link (the steward's candidates, each an agreed requirement and a BC of it), requirement or
// drop; either may be asked merge into the live issue it repeats. A draft requirement is asked merge,
// drop or keep, a draft revision of an agreed one withdraw or keep; a feedback item nobody triages is
// asked keep or decline, a fix nobody verifies verify, reopen or keep. Nothing is asked where the
// reading names an act somebody already owes, where the same question is open, where a person
// kept the item on the standing it reads now, or where a reasoned decision answers that standing
// (`decide-answered.ts`): each is said to the turn to correct, and is no refusal of the run.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { PLAIN_DECISION_RULE, plainDecisionSchema } from '@forge/contracts/plain-decision';
import { isAgreedStatus } from '@forge/contracts/requirements';
import {
  STEWARD_DECISION_OPTION_IDS,
  STEWARD_DECISIONS,
  STEWARD_LINK_CANDIDATES_MAX,
  STEWARD_MERGE_SHARED_TERMS_MIN,
  STEWARD_MERGE_SHARES_MAX,
  type StewardDecision,
  type StewardDecisionSubject,
  stewardDecisionLabel,
  stewardDecisionQuestion,
  stewardDecisionsFor,
  stewardFeedbackDecisionsFor,
  stewardLinkLabel,
  stewardLinkOptionId,
  stewardMergeLabel,
  stewardMergeOptionId,
  stewardRequirementDecisionsFor,
  stewardSharedTerms,
} from '@forge/contracts/steward';
import { z } from 'zod';
import { answeredAlready } from './decide-answered.js';
import { doorName } from './door-call.js';
import { cite, type DoorContext, type DoorSpec, key, send } from './door-kit.js';
import { openStandings } from './ports.js';

export { choseKeep } from './decide-answered.js';
export { decisionFingerprint, fingerprintOf } from './decision-ask.js';

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
      'for merge: the live item of the same kind it repeats, an issue for an issue and a requirement for a requirement, about the same thing: their titles share subject words',
    ),
  shares: z
    .string()
    .trim()
    .min(3)
    .max(STEWARD_MERGE_SHARES_MAX)
    .optional()
    .describe(
      'with `into`: what the two are both about, as a phrase a person reads after "Both are about" (e.g. "the BC trace syntax of issue criteria.")',
    ),
  why: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .describe('one line: why you recommend it, from the records you read'),
  plain: plainDecisionSchema
    .min(1)
    .optional()
    .describe(
      `what the person decides from, ${PLAIN_DECISION_RULE}; written for whoever owns the product, never for the master`,
    ),
  serious: z
    .boolean()
    .optional()
    .describe(
      'true only where the decision is irreversible, real money, credentials or product direction: on a strict project it is then asked of a person; every other decision is the master’s',
    ),
});
type DecideArgs = z.infer<typeof decideParams>;

interface Option {
  id: string;
  label: string;
  decision: StewardDecision;
  /** A merge's: what the two are both about. */
  shares?: string;
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
  if (!read.answer.ok || !isAgreedStatus(req.status ?? '')) {
    return `${requirement} is ${req.status ?? 'not a requirement of this project'}: a candidate is agreed or accepted`;
  }
  const hit = (req.criteria ?? []).find((x) => x.code.toUpperCase() === bc);
  if (!hit) return `${requirement} has no current ${bc}`;
  return {
    id: stewardLinkOptionId(requirement, bc),
    label: stewardLinkLabel(hit.body),
    decision: 'link',
  };
}

const LIVE_REQUIREMENT_ENDED = ['dropped', 'deferred'];

/**
 * A merge into a live item about the same thing (REQ-48 r3 BC-16): the two titles share subject
 * words, and the turn says what they share, which the answer shows. Else no merge is offered.
 */
function sameSubject(
  about: string,
  offer: Offer,
  target: string,
  title: string,
  shares: string | undefined,
): Option | string {
  const shared = stewardSharedTerms(offer.title, title);
  if (shared.length < STEWARD_MERGE_SHARED_TERMS_MIN) {
    return `${target} "${title}" is not about what ${about} "${offer.title}" is about (they share ${shared.length === 0 ? 'no subject word' : `only "${shared.join('", "')}"`}): offer no merge, ask without \`into\``;
  }
  if (!shares) return `merging into ${target} names what the two are both about in \`shares\``;
  return {
    id: stewardMergeOptionId(target),
    label: stewardMergeLabel(title),
    decision: 'merge',
    shares,
  };
}

/** A merge target checked: a live item of the draft's own kind, not the draft itself, about the same thing. */
async function mergeOption(
  into: string,
  offer: Offer,
  about: string,
  shares: string | undefined,
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
    return sameSubject(about, offer, target, req.title ?? '', shares);
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
  return sameSubject(about, offer, target, issue.title ?? '', shares);
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
    const option = await mergeOption(args.into, offer, args.about.toUpperCase(), args.shares, ctx);
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
    "Ask whoever decides a stuck item (an issue, REQ-n or FB-n) the one question its reading owes, with Forge's own options. An issue draft is prepared first (steward_prepare_draft): once it passes the issue-ready check it is asked open, keep or drop, recommending open; where no agreed requirement fits, it is asked link (your candidates, best first), requirement or drop; a draft repeating a live issue about the same thing may be asked merge (`into`, with `shares`: what both are about; their titles must share subject words, else no merge is offered). Unstarted work no master serves is kept waiting or dropped. A draft requirement its author does not finish is asked merge (`into` the live requirement it repeats), drop or keep; a draft revision of an agreed one withdraw or keep. A feedback item nobody triages is asked keep or drop (decline); a fix nobody verifies verify, reopen or keep. You pick the recommended one and say why in one line; nobody is ever asked to write a plan or criteria.",
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
        `${about} is ${offer.state}${code ? ` and reads ${code}` : ''}: ${wait ? `it waits on ${wait.who} to ${wait.act}, an act already owed` : 'it owes no decision'}. Ask nothing here: ask whoever owes it (steward_wake_master picks the master or the release holders) or write the note.`,
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
    const answered = await answeredAlready(ctx.projectId, about, offer.subject, standing ?? null);
    if (answered) return correct(answered);
    const prompt = stewardDecisionQuestion(
      options.map((o) => o.id),
      { kind: offer.subject.kind, draft: offer.draft },
    );
    const sent = await send(
      {
        method: 'POST',
        path: `/api/projects/${ctx.projectId}/steward-runs/${ctx.runId}/decisions`,
        body: {
          about,
          prompt,
          options: options.map((o) => ({
            id: o.id,
            label: o.label,
            ...(o.shares ? { shares: o.shares } : {}),
          })),
          recommendedOptionId: recommended.id,
          why: args.why,
          ...(args.plain ? { plain: args.plain } : {}),
          basis,
          ...(args.serious ? { serious: true } : {}),
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
