// The owner's Forge act, made as him from his own message in a room (ISS-1243 item 24, owner
// 2026-11-16: when he asks the agent to approve or settle something in Forge, it does it rather than
// send him to a page). `owner-act.ts` acts as him in a product, and `release-decision.ts` decides a
// release; the other acts his Needs you owes him (accept a requirement, approve a design, cut a
// release) had no door from a room, so the agent could only answer "go to page X and press Y".
//
// Who asked is the chat server's word, never the message's: the message must be one this room
// received from a member in the thread named, its author the account the room's binding names as
// owner (`grants.owner`), mapped to his Forge account by a confirmed speaker link or the address the
// chat server verified (`ops-asker.ts:forgeUserOfWriter`). A message by anyone else acts as nobody,
// whatever it says of who wrote it. The act then goes through its item's own door
// (`assistant/tools/item-act-doors.ts`, the one the item page and the web chat call) as him, so his
// own grants decide and the door's refusal is passed on by its own name. The reason it records
// quotes his message by id and thread, and the room's record keeps the act beside it.

import type { SupportForgeActRequest } from '@forge/contracts/support-channel';
import { makeItemAct, planItemAct } from '../assistant/index.js';
import { isRefusal } from '../lib/refusal.js';
import { memberMessage } from './channel-store.js';
import { granters, grantsOf, supportConfigOf } from './grants.js';
import { type Asker, forgeUserOfWriter } from './ops-asker.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker } from './ops-writes.js';
import { no } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

/** How much of his message the act's reason quotes. */
const QUOTE_MAX = 300;

const quoted = (text: string | null): string => {
  const words = (text ?? '').replace(/\s+/g, ' ').trim();
  return words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1)}…` : words;
};

/** The door's own refusal, passed on by its own code: the door, not this room, said no. */
const doorSaid = (code: string, detail: string): OpsOutcome<never> => ({
  ok: false,
  refusals: [{ code, path: '/act', detail: `${detail} Nothing was done` }],
});

/** The acts whose door takes no reason: his message is cited on the room's record alone. */
const NO_REASON = new Set<SupportForgeActRequest['act']>([
  'requirement.propose',
  'workflow.propose',
  'release.cut',
]);

/** Who he is, by the chat server's record of who wrote `message`, or the refusal naming why not. */
async function ownerOfMessage(
  room: RoomRow,
  input: SupportForgeActRequest,
): Promise<
  OpsOutcome<{ asker: Asker; said: NonNullable<Awaited<ReturnType<typeof memberMessage>>> }>
> {
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread) {
    return no(
      'SUPPORT_FORGE_ACT_NOT_HIS_MESSAGE',
      '/message',
      `${input.message} is ${said ? `a message in thread ${said.thread}, not ${input.thread}` : "no member's message this room received"}: the owner's Forge act is his own word, so cite his own message in the thread you name (\`message\` in what you were handed). Nothing was done`,
    );
  }
  const owner = grantsOf(await supportConfigOf(room)).owner;
  if (!owner) {
    return no(
      'SUPPORT_FORGE_ACT_NO_OWNER',
      '/message',
      `this room's binding names no owner (\`grants.owner\`, his chat account), so no message here acts as him in Forge. To name him, ${await granters(room.projectId)}. Nothing was done`,
    );
  }
  if (said.authorKey !== owner) {
    const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
    return no(
      'SUPPORT_FORGE_ACT_NOT_THE_OWNER',
      '/message',
      `${who} wrote ${input.message}, as the chat server recorded it, and only the owner this room's binding names acts as him in Forge: nobody else's message does, whatever it says of who wrote it. Nothing was done; ${who} makes the act on its page with their own account, or the owner asks for it himself`,
    );
  }
  const asker = await forgeUserOfWriter(room, { key: said.authorKey, label: said.author });
  if (!asker.ok) return asker;
  return { ok: true, value: { asker: asker.value, said } };
}

/** The reason the door records: his why where given, then his message, cited by id and thread. */
function reasonOf(
  room: RoomRow,
  input: SupportForgeActRequest,
  said: { author: string | null; authorKey: string; text: string | null },
): string | undefined {
  if (NO_REASON.has(input.act)) return undefined;
  const who = said.author ? `@${said.author}` : `account ${said.authorKey}`;
  const cite = `${who} asked for it in the room, message ${input.message} in thread ${input.thread} of group ${room.rid}: "${quoted(said.text)}"`;
  return input.reason ? `${input.reason.trim()}. ${cite}` : cite;
}

async function act(room: RoomRow, input: SupportForgeActRequest): Promise<OpsOutcome<unknown>> {
  const him = await ownerOfMessage(room, input);
  if (!him.ok) return him;
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const { asker, said } = him.value;
  const reason = reasonOf(room, input, said);
  const at = { projectId: project.value.id, userId: asker.userId };
  return asAsker(asker, project.value.id, async (): Promise<OpsOutcome<unknown>> => {
    // read as him, as the item's page would offer it: his grants and the item's state decide
    const plan = await planItemAct(
      { act: input.act, key: input.item, ...(reason ? { reason } : {}) },
      at,
    );
    if (!plan.ok) return doorSaid(plan.code, plan.why);
    const made = await makeItemAct(plan.plan, reason, at);
    if (!made.ok) return doorSaid(made.code, `${made.detail}.`);
    return {
      ok: true,
      value: {
        act: input.act,
        key: plan.key,
        project: project.value.slug,
        madeBy: asker.label ?? asker.key,
        recorded: plan.said,
      },
    };
  });
}

/**
 * Make the owner's Forge act from his own message (ISS-1243 item 24): as him, through the act's own
 * door, or refused by name with nothing done. Either way the act is on the room's record beside his
 * message, as his.
 */
export async function ownerForgeAct(
  room: RoomRow,
  input: SupportForgeActRequest,
): Promise<OpsOutcome<unknown>> {
  let out: OpsOutcome<unknown>;
  try {
    out = await act(room, input);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    out = { ok: false, refusals: [...err.refusals] };
  }
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: input.thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'session',
    tool: 'forge_act',
    input: { ...input, citedBy: 'session' },
    output: out.ok ? out.value : { refusals: out.refusals },
  });
  return out;
}
