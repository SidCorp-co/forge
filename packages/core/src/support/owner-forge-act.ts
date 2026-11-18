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

import { ITEM_ACT_NAMES, type ItemAct } from '@forge/contracts/item-acts';
import { SUPPORT_FORGE_ACTS, type SupportForgeActRequest } from '@forge/contracts/support-channel';
import { makeItemAct, planItemAct } from '../assistant/index.js';
import { type MembershipAct, membershipActByName } from '../ecosystem/index.js';
import { applyMergeMarker, listIssues, settleReleaseOnMark } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { writeBinding, writeProjectConfig } from '../project-config/index.js';
import { decideApprovalOfVersion, parseDecision } from '../release-batch/index.js';
import { memberMessage } from './channel-store.js';
import { granters, grantsOf, supportConfigOf } from './grants.js';
import { type Asker, forgeUserOfWriter } from './ops-asker.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker } from './ops-writes.js';
import { no } from './outcome.js';
import { doorOfDecision } from './owner-acts-reach.js';
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
const NO_REASON = new Set<string>([
  'requirement.propose',
  'workflow.propose',
  'release.cut',
  'config.write',
  'binding.write',
  'ecosystem.invite',
  'membership.accept',
  'membership.decline',
]);

/** The ecosystem membership acts (ISS-1299), each the verb its own service takes. */
const MEMBERSHIP: Readonly<Record<string, MembershipAct>> = {
  'ecosystem.invite': 'invite',
  'membership.accept': 'accept',
  'membership.decline': 'decline',
  'membership.leave': 'leave',
};
/** How long a membership's leave reason may be, as its route takes it. */
const LEAVE_REASON_MAX = 500;

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

/** The acts an item's page offers, made through `item-act-doors.ts`. */
const ITEM_ACT = new Set<string>(ITEM_ACT_NAMES);

/** Which act each field belongs to: a field on any other act is the request's shape, refused. */
const FIELD_OF: Record<'carry' | 'commit' | 'document' | 'baseRevision', readonly string[]> = {
  carry: ['release.approve'],
  commit: ['issue.merge'],
  document: ['config.write', 'binding.write'],
  baseRevision: ['config.write', 'binding.write'],
};

const FORGE_ACT = new Set<string>(SUPPORT_FORGE_ACTS);

function shapeRefusal(input: SupportForgeActRequest): OpsOutcome<never> | null {
  if (!FORGE_ACT.has(input.act)) {
    const door = doorOfDecision(input.act);
    if (door?.tool === null) {
      return no(
        'SUPPORT_FORGE_ACT_NO_DOOR',
        '/act',
        `${input.act} is an act his Needs you can owe, and no door from chat makes it yet: it is made on ${door.page} by his own account. Nothing was done; tell him in one line that this act cannot be made from chat yet and where he makes it, never that it is being done, and do the rest of what he asked`,
      );
    }
    return no(
      'SUPPORT_FORGE_ACT_NO_CONSENT_PATH',
      '/act',
      `${input.act} is no act Forge makes as the owner from chat. The acts it makes as him are ${SUPPORT_FORGE_ACTS.join(', ')}; an open question he answers is recorded with answer_question citing his message, a release decision with release_decision, and an act in a product with owner_act. Anything else is made on its page by his own account. Nothing was done; tell him which act is missing, never that it is being done`,
    );
  }
  for (const [field, acts] of Object.entries(FIELD_OF)) {
    if (input[field as keyof typeof FIELD_OF] !== undefined && !acts.includes(input.act)) {
      return no(
        'SUPPORT_FORGE_ACT_SHAPE',
        `/${field}`,
        `${field} belongs to ${acts.join(' and ')}, not ${input.act}; leave it out. Nothing was done`,
      );
    }
  }
  if (FIELD_OF.document.includes(input.act) && input.document === undefined) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/document',
      `${input.act} writes the whole document as it is to stand: read it, make his change, and pass it as document with the revision you read as baseRevision. Nothing was done`,
    );
  }
  return null;
}

/** His permission on the project, as the act's own route asks it, or the refusal it would meet. */
async function permitted(
  userId: string,
  projectId: string,
  permission: 'project.write' | 'project.admin',
  what: string,
): Promise<OpsOutcome<never> | null> {
  const refused = await permissionRefusalFor(
    actorFor(userId),
    permission,
    projectResource(projectId),
    what,
  );
  return refused
    ? { ok: false, refusals: [{ code: refused.code, path: '/act', detail: refused.detail }] }
    : null;
}

/** An act on an item's page, read as him the way the page offers it, then made through its door. */
async function itemAct(
  input: SupportForgeActRequest,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const act = input.act as ItemAct;
  // read as him, as the item's page would offer it: his grants and the item's state decide
  const plan = await planItemAct({ act, key: input.item, ...(reason ? { reason } : {}) }, at);
  if (!plan.ok) return doorSaid(plan.code, plan.why);
  if (act === 'release.approve' && input.carry) {
    // the release door's own carry: the unproven criteria he lets go, kept on the approval
    await decideApprovalOfVersion({
      projectId: at.projectId,
      version: plan.plan.ref,
      userId: at.userId,
      decision: parseDecision({ decision: 'approve', reason, carry: input.carry }),
    });
  } else {
    const made = await makeItemAct(plan.plan, reason, at);
    if (!made.ok) return doorSaid(made.code, `${made.detail}.`);
  }
  return { ok: true, value: { key: plan.key, recorded: plan.said } };
}

/** The merge mark, as `POST /api/issues/:id/merge` makes it: a person's claim that the work landed. */
async function markMerged(
  input: SupportForgeActRequest,
  reason: string | undefined,
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const denied = await permitted(
    at.userId,
    at.projectId,
    'project.write',
    'marking an issue merged',
  );
  if (denied) return denied;
  const listed = await listIssues(
    at.projectId,
    { key: input.item },
    { sort: 'updatedAt:desc', limit: 1, offset: 0 },
  );
  const issue = listed.ok ? listed.rows[0] : undefined;
  if (!issue) {
    return no(
      'OPS_ISSUE_UNKNOWN',
      '/item',
      `this project holds no issue ${input.item}. Nothing was done`,
    );
  }
  const hookActor = { type: 'user' as const, id: at.userId, agency: 'human' as const };
  const marked = await applyMergeMarker({
    issue: { id: issue.id, projectId: at.projectId, mergedAt: issue.mergedAt ?? null },
    op: 'mark',
    ...(reason ? { note: reason } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    actor: { agency: 'human', commentAuthorId: at.userId, hookActor, box: null },
  });
  await settleReleaseOnMark(issue.id, hookActor);
  return { ok: true, value: { key: input.item, recorded: `${marked.mark}: ${marked.markDetail}` } };
}

/** An ecosystem membership act, as its own service makes it for him (ISS-1299). */
async function membershipAct(
  input: SupportForgeActRequest,
  reason: string | undefined,
  at: { projectId: string; projectSlug: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const verb = MEMBERSHIP[input.act] as MembershipAct;
  const made = await membershipActByName({
    act: verb,
    ecosystem: input.item,
    projectId: at.projectId,
    projectSlug: at.projectSlug,
    userId: at.userId,
    reason: reason ? quotedTo(reason, LEAVE_REASON_MAX) : null,
  });
  if (!made.ok) return { ok: false, refusals: made.refusals };
  return {
    ok: true,
    value: {
      key: input.item,
      recorded: `${at.projectSlug} in ${input.item}: membership ${made.membership.id}, ${made.membership.state}`,
    },
  };
}

const quotedTo = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The project document or one binding, written whole at the revision read, as its door writes it. */
async function writeDocument(
  input: SupportForgeActRequest,
  at: { projectId: string; userId: string },
): Promise<OpsOutcome<{ key: string; recorded: string }>> {
  const denied = await permitted(
    at.userId,
    at.projectId,
    'project.admin',
    input.act === 'config.write' ? 'changing the project document' : 'changing a binding',
  );
  if (denied) return denied;
  const baseRevision = input.baseRevision ?? null;
  const written =
    input.act === 'config.write'
      ? await writeProjectConfig({ ...at, baseRevision, raw: input.document })
      : await writeBinding({ ...at, bindingId: input.item, baseRevision, raw: input.document });
  if (!written.ok) return { ok: false, refusals: written.refusals.map((r) => ({ ...r })) };
  return {
    ok: true,
    value: {
      key: input.item,
      recorded: `${input.act === 'config.write' ? 'the project document' : `binding ${input.item}`} at revision ${written.held.revision}`,
    },
  };
}

async function act(room: RoomRow, input: SupportForgeActRequest): Promise<OpsOutcome<unknown>> {
  const shape = shapeRefusal(input);
  if (shape) return shape;
  const him = await ownerOfMessage(room, input);
  if (!him.ok) return him;
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const { asker, said } = him.value;
  const reason = reasonOf(room, input, said);
  const at = { projectId: project.value.id, userId: asker.userId };
  const made = await asAsker(asker, project.value.id, () =>
    ITEM_ACT.has(input.act)
      ? itemAct(input, reason, at)
      : input.act === 'issue.merge'
        ? markMerged(input, reason, at)
        : MEMBERSHIP[input.act]
          ? membershipAct(input, reason, { ...at, projectSlug: project.value.slug })
          : writeDocument(input, at),
  );
  if (!made.ok) return made;
  return {
    ok: true,
    value: {
      act: input.act,
      key: made.value.key,
      project: project.value.slug,
      madeBy: asker.label ?? asker.key,
      recorded: made.value.recorded,
    },
  };
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
    tool: 'owner_forge_act',
    input: { ...input, citedBy: 'session' },
    output: out.ok ? out.value : { refusals: out.refusals },
  });
  return out;
}
