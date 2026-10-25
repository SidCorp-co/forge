// The steward's ask of whoever owes an item's act (REQ-48 BC-5, ISS-607). The door picks the
// addressee from the item's standing, never the model: the project's master, woken and asked until the
// item's standing moves; or, for a release approval or a feedback triage the master may not take, the
// holders of that act's permission, told once in their notices (ISS-654). An item already asked on
// the standing it reads now, or with a decision recorded on it, is not asked again: that is said to
// the turn, and nothing is written. The ask cites the item it is about, which keys it (`asks.ts`).

import type { ItemStanding } from '@forge/contracts/steward';
import { z } from 'zod';
import { emitNotification } from '../notifications/index.js';
import { heldStewardOf } from './account.js';
import { askAddresseeOf, unreadLine } from './ask-addressee.js';
import { askedAlready, WAKE_DOOR } from './asks.js';
import type { DoorAnswer, DoorRequest } from './door-call.js';
import { type DoorContext, type DoorSpec, key } from './door-kit.js';
import { openStandings, stewardPorts } from './ports.js';

const wakeParams = z.strictObject({ about: key, ask: z.string().trim().min(10).max(500) });

/** The standing of the item the ask is about: this run's own, or another open item's by its key. */
async function standingOfKey(about: string, ctx: DoorContext): Promise<ItemStanding | null> {
  if (about === ctx.subject.key.toUpperCase() && ctx.standing) return ctx.standing;
  const rows = await openStandings(ctx.projectId);
  return rows.find((r) => r.subject.key.toUpperCase() === about) ?? null;
}

const answered = (json: Record<string, unknown>): DoorAnswer => ({
  status: 200,
  ok: true,
  json,
  text: JSON.stringify(json),
});

export const WAKE: DoorSpec<z.infer<typeof wakeParams>> = {
  name: 'steward_wake_master',
  describe:
    "Ask whoever owes an item's act to take it: the project's master, woken and asked until the item's standing moves; or, where the item waits on a release approval or a feedback triage the master may not take, the holders of that permission. The door picks whom from the standing. An item already asked on its standing now is not asked again.",
  params: wakeParams,
  write: true,
  async call(args, ctx) {
    const about = args.about.toUpperCase();
    // keyed on the item asked about, whichever run asks (ISS-607: FB-runs asked on ISS-498 again)
    const standing = await standingOfKey(about, ctx);
    if (standing) {
      const again = await askedAlready(ctx.projectId, standing, new Date());
      if (again) return { correct: again };
    }
    const cite = standing ? { kind: standing.subject.kind, ref: standing.subject.key } : null;
    const steward = await heldStewardOf(ctx.projectId);
    const to = await askAddresseeOf(ctx.projectId, standing, steward);
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
  },
};
