// The steward's ask of whoever owes an item's act (REQ-48 BC-5, ISS-607). The door picks the
// addressee from the item's standing, never the model: the project's master, woken and asked until the
// item's standing moves; or, for a release approval or a feedback triage the master may not take, the
// holders of that act's permission, told once in their notices (ISS-654). A wait a person owes asks
// nobody: it is theirs, on their Needs you, and the turn is told so (ISS-739). An issue waiting on a
// person's answer to its question is asked on the item it serves: the door places the question there
// (`questions/on-item.ts`), the requirement the turn names in `item` where the issue serves neither a
// requirement nor a feedback item, else it stays the project's question in Needs you, and logs the
// ask under `ASK_ON_ITEM_DOOR`, naming no person (REQ-68 BC-4, ISS-687). An item already asked on
// the standing it reads now, or with a decision recorded on it or on the asking run's own item, is not
// asked again: that is said to the turn, and nothing is written. The ask cites the item it is about,
// which keys it (`asks.ts`).
// An issue owing nothing of its own (every criterion earned, on a project with production) waits on
// the release that carries it: an ask about it is raised on that release, once while the release's
// wait reads the same, of whoever takes the release's act (`release-ask.ts`, ISS-1040).

import type { ItemStanding } from '@forge/contracts/steward';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { isRefusal } from '../lib/refusal.js';
import { emitNotification } from '../notifications/index.js';
import { placeOpenQuestionsOnItem } from '../questions/index.js';
import { heldStewardOf } from './account.js';
import { recordAct } from './acts-store.js';
import { askAddresseeOf, unreadLine } from './ask-addressee.js';
import { ASK_ON_ITEM_DOOR, askedAlready, lockAsksOn, WAKE_DOOR } from './asks.js';
import { decisionSubjectOf } from './decision-subject-of.js';
import type { DoorAnswer, DoorRequest } from './door-call.js';
import { type ActOf, type DoorContext, type DoorSpec, key } from './door-kit.js';
import { openStandings, stewardPorts } from './ports.js';
import { askOnRelease } from './release-ask.js';

const wakeParams = z.strictObject({
  about: key,
  ask: z.string().trim().min(10).max(500),
  /** The requirement (REQ-n) an issue serving no requirement or feedback item serves, where the turn can tell. */
  item: z
    .string()
    .trim()
    .regex(/^REQ-\d+$/i, 'item names a requirement by its key, REQ-n')
    .optional(),
});

/** The standing of the item the ask is about: this run's own, or another open item's by its key. */
async function standingOfKey(about: string, ctx: DoorContext): Promise<ItemStanding | null> {
  if (about === ctx.subject.key.toUpperCase() && ctx.standing) return ctx.standing;
  const rows = await openStandings(ctx.projectId);
  return rows.find((r) => r.subject.key.toUpperCase() === about) ?? null;
}

/** The issue a key names, from its standing where it has one, else the project's records; null for any other item. */
async function issueIdOf(
  about: string,
  standing: ItemStanding | null,
  projectId: string,
): Promise<string | null> {
  if (standing) return standing.subject.kind === 'issue' ? standing.subject.id : null;
  if (/^(REQ|FB)-\d+$/i.test(about)) return null;
  try {
    const subject = await decisionSubjectOf(projectId, about);
    return subject.kind === 'issue' ? subject.id : null;
  } catch (err) {
    // a key naming no item of the project: the ask below goes on as it always has
    if (isRefusal(err)) return null;
    throw err;
  }
}

const answered = (json: Record<string, unknown>): DoorAnswer => ({
  status: 200,
  ok: true,
  json,
  text: JSON.stringify(json),
});

type WakeAnswer = Awaited<ReturnType<DoorSpec<z.infer<typeof wakeParams>>['call']>>;

/** The ask itself, taken under the item's ask lock: checked against the asks on its standing first. */
/** The ask of an issue's answer: its open questions placed on the item it serves, said naming no person. */
async function askOnItem(
  about: string,
  issueId: string,
  named: string | undefined,
  ctx: DoorContext,
  tx: Tx,
): Promise<{ request: DoorRequest; answer: DoorAnswer; act: ActOf } | { correct: string } | null> {
  let placed: Awaited<ReturnType<typeof placeOpenQuestionsOnItem>>;
  try {
    placed = await placeOpenQuestionsOnItem({ projectId: ctx.projectId, issueId, named }, tx);
  } catch (err) {
    // a requirement the turn named that the project does not hold: said to the turn, nothing placed
    if (isRefusal(err)) return { correct: err.refusals.map((r) => r.detail).join('; ') };
    throw err;
  }
  // a wait on an answer no open question asks (a bare needs_info) is the master's to ask
  if (placed.questions.length === 0) return null;
  const prompts = placed.questions.map((q) => q.prompt.trim()).filter(Boolean);
  const asked = prompts.join(' / ').slice(0, 400);
  const where = placed.item
    ? `Asked on ${placed.item.key} about ${about}`
    : `Asked in Needs you about ${about}, as the project's question`;
  return {
    request: { method: 'POST', path: `/questions/on-item/${about}` },
    answer: answered({
      askedOn: placed.item?.key ?? 'project',
      questions: placed.questions.map((q) => q.id),
    }),
    act: {
      door: ASK_ON_ITEM_DOOR,
      did: asked ? `${where}: ${asked}` : where,
      wrote: null,
      undo: null,
    },
  };
}

async function askOnce(
  args: z.infer<typeof wakeParams>,
  ctx: DoorContext,
  about: string,
  tx: Tx,
): Promise<WakeAnswer> {
  // keyed on the item asked about, whichever run asks (ISS-607: FB-runs asked on ISS-498 again)
  const standing = await standingOfKey(about, ctx);
  // an issue owing nothing of its own is shipped by the release carrying it, which is asked instead
  const issueId = await issueIdOf(about, standing, ctx.projectId);
  const release = issueId ? await stewardPorts().releaseHoldingAct(ctx.projectId, issueId) : null;
  if (release) return askOnRelease(args.ask, ctx, about, release, tx);
  if (standing) {
    // the run's own item answers an ask about its blocker too (ISS-739: ISS-748 asking about ISS-746)
    const asker = about === ctx.subject.key.toUpperCase() ? null : ctx.standing;
    const again = await askedAlready(ctx.projectId, standing, new Date(), asker);
    if (again) return { correct: again };
  }
  const cite = standing ? { kind: standing.subject.kind, ref: standing.subject.key } : null;
  const steward = await heldStewardOf(ctx.projectId);
  const to = await askAddresseeOf(ctx.projectId, standing, steward);
  if (to.to === 'item') {
    const asked = await askOnItem(about, to.issueId, args.item, ctx, tx);
    if (asked && 'correct' in asked) return asked;
    if (asked) return { ...asked, act: { ...asked.act, wrote: cite } };
  }
  if (to.to === 'person') {
    const owes = to.act ? `${to.who} to ${to.act}` : to.who;
    return {
      correct: `${about} waits on ${owes}: a person's act, on their Needs you, which the master's account holds no permission for. Ask nothing of the master; write the note saying so.`,
    };
  }
  if (to.to === 'nobody') {
    return {
      correct: `${about} waits on a ${to.act.what}, and ${to.why}: ask nothing; write the note saying so.`,
    };
  }
  if (to.to === 'holders') {
    const names = to.holders.map((h) => h.name).join(', ');
    const notice = await emitNotification({
      recipients: to.holders.map((h) => h.id),
      projectId: ctx.projectId,
      type: 'steward_ask',
      title: `${about}: ${to.act.what} asked`,
      body: args.ask,
      issueId: standing?.subject.kind === 'issue' ? standing.subject.id : null,
      dedupeKey: `steward-ask:${ctx.runId}:${about}`,
    });
    const request: DoorRequest = { method: 'POST', path: '/notify/steward_ask' };
    return {
      request,
      answer: answered({ askedOf: to.act.permission, holders: names, ...notice }),
      act: {
        door: to.act.door,
        did: `Asked the ${to.act.permission} holders (${names}) about ${about}: ${args.ask}${to.unread.length > 0 ? ` (${unreadLine(to.unread)})` : ''}`,
        wrote: cite,
        undo: null,
      },
    };
  }
  const woke = await stewardPorts().wakeMasters({
    projectId: ctx.projectId,
    subjectKey: about,
    ask: args.ask,
  });
  return {
    request: { method: 'POST', path: `/ws/master.wake/steward` },
    answer: answered({ askedOf: 'master', ...woke }),
    act: {
      door: WAKE_DOOR,
      did: `Asked the master about ${about}: ${args.ask}`,
      wrote: cite,
      undo: null,
      masterAsk: `${about}: ${args.ask}`,
    },
  };
}

export const WAKE: DoorSpec<z.infer<typeof wakeParams>> = {
  name: 'steward_wake_master',
  describe:
    "Ask whoever owes an item's act to take it: the project's master, woken and asked until the item's standing moves; or, where the item waits on a release approval or a feedback triage the master may not take, the holders of that permission; or, where an issue waits on a person's answer to its question, that question, placed on the requirement or feedback item the issue serves so a person decides it there. Where such an issue serves neither and you can tell which requirement it serves, name it in `item` (REQ-n); otherwise it stays the project's question in Needs you. The door picks whom from the standing. An item already asked on its standing now is not asked again.",
  params: wakeParams,
  write: true,
  async call(args, ctx) {
    const about = args.about.toUpperCase();
    // two runs asking about one item at once ask once: the check, the ask and its record run under
    // the item's lock, so the second reads the first's ask and is told it stands
    return db.transaction(async (tx) => {
      await lockAsksOn(tx, ctx.projectId, about);
      const out = await askOnce(args, ctx, about, tx);
      if ('correct' in out || !out.act) return out;
      ctx.acts.push(
        await recordAct(
          { ...out.act, runId: ctx.runId, projectId: ctx.projectId, act: ctx.act },
          tx,
        ),
      );
      const { act: _recorded, ...asked } = out;
      return asked;
    });
  },
};
