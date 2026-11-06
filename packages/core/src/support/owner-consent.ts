// The owner's consent to his room acting as him in a product (ISS-1013, REQ-85 BC-1, BC-3, BC-7).
// He gives it once, in his own words in his own room; the room's agent reads that his message is the
// agreement (the agent is the voice: core composes no handshake and asks no set word) and cites it,
// and core records the fact after checking what the chat server signed: the message is the owner's,
// the binding names him, and it was written in the owner's room. Who, when, which product and which
// room are the row. One plain word of his, cited the same way, withdraws it, and the room acts as
// him no more. Any other room, or a room without his standing consent, is refused by name, saying
// who can consent.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions, supportOwnerConsents } from '../db/schema-support.js';
import { readSupportApis } from '../integrations/support-api/index.js';
import { memberMessage } from './channel-store.js';
import { granters, grantsOf, supportConfigOf } from './grants.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type ConsentRow = typeof supportOwnerConsents.$inferSelect;

/** The owner a room acts for, and the room he gives his word in, as the binding names them now. */
export interface OwnerRoom {
  owner: string;
  ownerRoom: string;
}

/** The username the owner writes under, as Forge saw it on one of his messages in this project. */
export async function ownerUsername(projectId: string, ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ label: supportActions.actorLabel })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.projectId, projectId),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKey, ownerId),
      ),
    )
    .orderBy(asc(supportActions.createdAt))
    .limit(1);
  return row?.label ?? null;
}

/** Who can consent, said the same way by every refusal: the owner, by name, in his own room. */
export async function whoCanConsent(room: RoomRow, at: OwnerRoom): Promise<string> {
  const name = await ownerUsername(room.projectId, at.owner);
  const who = name ? `@${name}` : `the owner (Rocket.Chat account ${at.owner})`;
  return `only ${who}, the owner this binding names, can consent, in his own words in his own room ${at.ownerRoom}`;
}

/** Who signs in to the product as the owner, said the same way by every refusal that needs him to (ISS-1047). */
export async function whoSignsIn(room: RoomRow, at: OwnerRoom): Promise<string> {
  const name = await ownerUsername(room.projectId, at.owner);
  const who = name ? `@${name}` : `the owner (Rocket.Chat account ${at.owner})`;
  return `only ${who}, the owner this binding names, signs in, from his own room ${at.ownerRoom}`;
}

/**
 * The owner and his room, where `room` is that room; otherwise the refusal naming why and who can
 * consent. Only a channel agent's binding names an owner's room (ISS-872), and the binding's grant
 * names the owner by the account the chat server signs.
 */
export async function ownerRoomOf(room: RoomRow, act: string): Promise<Outcome<OwnerRoom>> {
  const config = room.kind === 'agent' ? await supportConfigOf(room) : null;
  const owner = grantsOf(config).owner;
  const ownerRoom = config?.ownerRoom;
  if (!owner || !ownerRoom) {
    return no(
      'SUPPORT_OWNER_OTHER_ROOM',
      '/action',
      `${act} is taken only in the owner's own room, and this room's binding names ${
        owner ? 'no owner’s room (`agent.ownerRoom`)' : 'no owner (`grants.owner`)'
      }, so nobody can consent here and nothing was done. To name them, ${await granters(room.projectId)}.`,
    );
  }
  if (room.rid !== ownerRoom) {
    return no(
      'SUPPORT_OWNER_OTHER_ROOM',
      '/action',
      `${act} is taken only in the owner's own room ${ownerRoom}, and this is ${room.rid}: no other room acts as him, so nothing was done; ${await whoCanConsent(room, { owner, ownerRoom })}.`,
    );
  }
  return { ok: true, value: { owner, ownerRoom } };
}

/** A product the room may act in: one of the project's support-api bindings, by its name. */
export interface Product {
  bindingId: string;
  name: string;
}

/** The project's products, as the `tools` list names them. */
export async function productsOf(projectId: string): Promise<Product[]> {
  return (await readSupportApis(projectId)).map((r) =>
    r.ok
      ? { bindingId: r.api.bindingId, name: r.api.name }
      : { bindingId: r.bindingId, name: r.name },
  );
}

/** The product a consent names; the one product where it names none and the project binds one. */
export function productNamed(products: Product[], name: string | undefined): Outcome<Product> {
  const names = products.map((p) => p.name).join(', ') || 'none';
  if (name === undefined) {
    if (products.length === 1) return { ok: true, value: products[0] as Product };
    return no(
      'SUPPORT_OWNER_PRODUCT_UNKNOWN',
      '/product',
      products.length === 0
        ? 'this project binds no product API (support-api), so there is nothing the room could act in; nothing was recorded'
        : `this project binds ${products.length} products (${names}): name the one he agreed to as product; nothing was recorded`,
    );
  }
  const found = products.find((p) => p.name === name);
  if (!found) {
    return no(
      'SUPPORT_OWNER_PRODUCT_UNKNOWN',
      '/product',
      `this project binds no product named ${name}; it binds ${names}. Nothing was recorded.`,
    );
  }
  return { ok: true, value: found };
}

/** The consent standing for a room in a product, or null where none stands. */
export async function standingConsent(
  roomId: string,
  bindingId: string,
): Promise<ConsentRow | null> {
  const [row] = await db
    .select()
    .from(supportOwnerConsents)
    .where(
      and(
        eq(supportOwnerConsents.roomId, roomId),
        eq(supportOwnerConsents.bindingId, bindingId),
        isNull(supportOwnerConsents.withdrawnAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A consent as the session is handed it: who, when, which product, which room, and his message. */
export interface ConsentView {
  product: string;
  room: string;
  owner: { account: string; name: string | null };
  givenAt: string;
  /** How he gave it: his message in his room, or the sign-in core started for him (ISS-1047). */
  route: ConsentRow['route'];
  /** His message saying so; null where he gave it by signing in. */
  givenMessage: string | null;
  withdrawnAt: string | null;
  withdrawnMessage: string | null;
}

const viewOf = (row: ConsentRow, product: string, rid: string): ConsentView => ({
  product,
  room: rid,
  owner: { account: row.ownerKey, name: row.ownerLabel },
  givenAt: row.givenAt.toISOString(),
  route: row.route,
  givenMessage: row.givenMessage,
  withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  withdrawnMessage: row.withdrawnMessage,
});

export type ConsentAnswer =
  | { decision: 'give'; consent: ConsentView; already: boolean }
  | { decision: 'withdraw'; withdrawn: ConsentView[]; says: string };

/**
 * Record the owner's consent, or its withdrawal, from his own message the session cites. Refused by
 * name, and nothing recorded, outside the owner's room, for a thread or message this room did not
 * receive, a message the owner did not write, or a product the project does not bind.
 */
export async function ownerConsent(
  room: RoomRow,
  input: {
    thread: string;
    message: string;
    decision: 'give' | 'withdraw';
    product?: string | undefined;
  },
): Promise<Outcome<ConsentAnswer>> {
  const at = await ownerRoomOf(room, 'owner_consent');
  if (!at.ok) return at;
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread) {
    return no(
      'SUPPORT_MESSAGE_UNKNOWN',
      '/message',
      said
        ? `${input.message} is in thread ${said.thread}, not ${input.thread}: cite the owner's message in the thread you name. Nothing was recorded.`
        : `${input.message} is no member's message this room received; cite the id of the owner's own message. Nothing was recorded.`,
    );
  }
  if (said.authorKey !== at.value.owner) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'member',
      actorKey: said.authorKey,
      actorLabel: said.author,
      tool: 'owner_consent',
      input: { ...input, citedBy: 'session' },
      output: { code: 'SUPPORT_CONSENT_NOT_THE_OWNER' },
    });
    return no(
      'SUPPORT_CONSENT_NOT_THE_OWNER',
      '/message',
      `@${said.author ?? said.authorKey} wrote ${input.message}, and ${await whoCanConsent(room, at.value)}: nobody else's word is his consent or its withdrawal. Nothing was recorded.`,
    );
  }
  const products = await productsOf(room.projectId);
  const owner = { key: said.authorKey, label: said.author };
  if (input.decision === 'withdraw') {
    return withdraw(room, conversationId, input, owner, products);
  }
  const product = productNamed(products, input.product);
  if (!product.ok) return product;
  const standing = await standingConsent(room.id, product.value.bindingId);
  if (standing) {
    return {
      ok: true,
      value: {
        decision: 'give',
        consent: viewOf(standing, product.value.name, room.rid),
        already: true,
      },
    };
  }
  const row = await db.transaction(async (tx) => {
    const [made] = await tx
      .insert(supportOwnerConsents)
      .values({
        projectId: room.projectId,
        roomId: room.id,
        bindingId: product.value.bindingId,
        ownerKey: owner.key,
        ownerLabel: owner.label,
        thread: input.thread,
        givenMessage: input.message,
        givenAt: said.at,
      })
      .returning();
    if (!made) throw new Error('support: an owner consent insert returned no row');
    await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId,
        thread: input.thread,
        kind: 'owner_consented',
        actorKind: 'member',
        actorKey: owner.key,
        actorLabel: owner.label,
        tool: 'owner_consent',
        // the audit fact: which product, and which message of his, cited by the session, said so
        input: { product: product.value.name, message: input.message, citedBy: 'session' },
        output: { consent: made.id, bindingId: product.value.bindingId },
      },
      tx,
    );
    return made;
  });
  return {
    ok: true,
    value: { decision: 'give', consent: viewOf(row, product.value.name, room.rid), already: false },
  };
}

/** His word withdrawing it: the product he named, or every consent standing in the room. */
async function withdraw(
  room: RoomRow,
  conversationId: string,
  input: { thread: string; message: string; product?: string | undefined },
  owner: { key: string; label: string | null },
  products: Product[],
): Promise<Outcome<ConsentAnswer>> {
  let only: Product | null = null;
  if (input.product !== undefined) {
    const named = productNamed(products, input.product);
    if (!named.ok) return named;
    only = named.value;
  }
  const now = new Date();
  const ended = await db.transaction(async (tx) => {
    const rows = await tx
      .update(supportOwnerConsents)
      .set({ withdrawnAt: now, withdrawnMessage: input.message })
      .where(
        and(
          eq(supportOwnerConsents.roomId, room.id),
          isNull(supportOwnerConsents.withdrawnAt),
          ...(only ? [eq(supportOwnerConsents.bindingId, only.bindingId)] : []),
        ),
      )
      .returning();
    const named = (r: ConsentRow) =>
      products.find((p) => p.bindingId === r.bindingId)?.name ?? r.bindingId;
    await insertAction(
      {
        roomId: room.id,
        projectId: room.projectId,
        conversationId,
        thread: input.thread,
        kind: 'owner_withdrew',
        actorKind: 'member',
        actorKey: owner.key,
        actorLabel: owner.label,
        tool: 'owner_consent',
        input: { product: only?.name ?? null, message: input.message, citedBy: 'session' },
        output: { withdrawn: rows.map((r) => ({ consent: r.id, product: named(r) })) },
      },
      tx,
    );
    return rows.map((r) => viewOf(r, named(r), room.rid));
  });
  return {
    ok: true,
    value: {
      decision: 'withdraw',
      withdrawn: ended,
      says:
        ended.length > 0
          ? `the room acts as him no more in ${ended.map((c) => c.product).join(', ')}`
          : 'no consent of his stood in this room, so the room did not act as him and still does not',
    },
  };
}
