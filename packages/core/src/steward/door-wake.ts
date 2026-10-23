// The steward's ask of whoever owes an item's act (REQ-48 BC-5, ISS-607). The door picks the
// addressee from the item's standing, never the model: the project's master, woken and asked until the
// item's standing moves; or, for a release approval the master may not give, the release holders,
// told once in their notices. An item already asked on the standing it reads now, or whose ask a
// decision answered, is not asked again: that is said to the turn, and nothing is written.

import type { ItemStanding } from '@forge/contracts/steward';
import { z } from 'zod';
import { emitNotification } from '../notifications/index.js';
import { heldStewardOf } from './account.js';
import { askAddresseeOf } from './ask-addressee.js';
import { askedAlready, NOTIFY_HOLDERS_DOOR, WAKE_DOOR } from './asks.js';
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
    "Ask whoever owes an item's act to take it: the project's master, woken and asked until the item's standing moves; or, where the item waits on a release approval the master may not give, the release holders. The door picks whom from the standing. An item already asked on its standing now is not asked again.",
  params: wakeParams,
  write: true,
  async call(args, ctx) {
    const about = args.about.toUpperCase();
    const basis = ctx.standing?.basis ?? null;
    if (basis) {
      const again = await askedAlready(ctx.projectId, ctx.subject, basis, new Date());
      if (again) return { correct: again };
    }
    const standing = await standingOfKey(about, ctx);
    const steward = await heldStewardOf(ctx.projectId);
    const to = await askAddresseeOf(ctx.projectId, standing, steward);
    if (to.to === 'nobody') {
      return {
        correct: `${about} waits on a release approval, and ${to.why}: ask nothing; write the note saying so.`,
      };
    }
    if (to.to === 'release_holders') {
      const names = to.holders.map((h) => h.name).join(', ');
      const notice = await emitNotification({
        recipients: to.holders.map((h) => h.id),
        projectId: ctx.projectId,
        type: 'steward_ask',
        title: `${about}: release approval asked`,
        body: args.ask,
        issueId: standing?.subject.kind === 'issue' ? standing.subject.id : null,
        dedupeKey: `steward-ask:${ctx.runId}:${about}`,
      });
      const request: DoorRequest = { method: 'POST', path: '/notify/steward_ask' };
      return {
        request,
        answer: answered({ askedOf: 'release_holders', holders: names, ...notice }),
        act: {
          door: NOTIFY_HOLDERS_DOOR,
          did: `Asked the release holders (${names}) about ${about}: ${args.ask}`,
          wrote: null,
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
        wrote: null,
        undo: null,
        masterAsk: `${about}: ${args.ask}`,
      },
    };
  },
};
