import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { channelRoleRefusal, type Writer } from './channel-author.js';
import { holdRefusals, parseHold } from './channel-hold-rules.js';
import { HOLD_SCHEMA_ID, type HoldAction, type ThreadHold } from './channel-schema.js';
import { announceHold } from './channel-signals.js';
import { holdsOn, insertHold, readNumbered } from './channel-store.js';
import { holdOf, serveAll } from './channel-world.js';
import type { EcosystemRefusal } from './refusals.js';
import { lockKeys } from './store.js';

export type HoldOutcome =
  | { ok: true; hold: ThreadHold; held: boolean; parties: string[] }
  | { ok: false; refusals: EcosystemRefusal[] };

// cm:why the side is the project in the path, so a token fenced to one project acts for that side only
export async function holdOrRelease(args: {
  sideProjectId: string;
  thread: string;
  action: HoldAction;
  writer: Writer;
  reason: string | undefined;
}): Promise<HoldOutcome> {
  const { writer } = args;
  const outcome: HoldOutcome = await db.transaction(async (tx) => {
    await lockKeys(tx, [`channel-thread:${args.thread}`]);
    const row = await readNumbered(tx, args.thread);
    if (row?.state !== 'published') {
      return {
        ok: false,
        refusals: [
          {
            code: 'REF_UNRESOLVED',
            path: '/thread',
            detail: `no published document ${args.thread} opens a conversation; a hold names the number of the document that opened it.`,
          },
        ],
      };
    }
    const [served] = await serveAll(tx, [row]);
    const documents = new Map(served ? [[args.thread, served.document]] : []);
    const at = new Date();
    const parsed = parseHold({
      $schema: HOLD_SCHEMA_ID,
      version: 1,
      id: randomUUID(),
      ecosystem: row.ecosystemId,
      thread: args.thread,
      action: args.action,
      by: writer.author,
      side: args.sideProjectId,
      at: at.toISOString(),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    });
    if (!parsed.ok) return { ok: false, refusals: parsed.refusals };
    const hold = parsed.value;
    const mayAct = (await channelRoleRefusal(writer.userId, args.sideProjectId, 'write')) === null;
    const history = (await holdsOn(tx, [args.thread])).map(holdOf);
    const refusals = holdRefusals(hold, {
      documents,
      mayActFor: (person, project) =>
        person === writer.userId && project === args.sideProjectId && mayAct,
      holds: history,
    });
    if (refusals.length > 0) return { ok: false, refusals };
    await insertHold(tx, {
      id: hold.id,
      ecosystemId: row.ecosystemId,
      thread: hold.thread,
      action: hold.action,
      byKind: hold.by.kind,
      byId: hold.by.id,
      byVia: hold.by.via,
      userId: writer.userId,
      sideProjectId: hold.side,
      reason: hold.reason ?? null,
      at,
    });
    const thread = documents.get(args.thread);
    if (!thread) throw new Error(`channel: ${args.thread} was held without its document in hand`);
    return { ok: true, hold, held: hold.action === 'hold', parties: [thread.from, ...thread.to] };
  });
  if (outcome.ok) await announceHold(outcome.hold, outcome.parties);
  return outcome;
}
