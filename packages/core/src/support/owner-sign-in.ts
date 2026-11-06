// The owner's sign-in to a product, started by core (ISS-1047, REQ-85 BC-3's second route, BC-2,
// BC-4). In his own room the session asks for it; core makes a fresh OAuth state and PKCE pair, keeps
// the state's hash and the verifier (sealed) for half an hour, and hands the session the product's
// authorization URL to give him. He signs in to the product and confirms there; the product sends
// his browser back to core's callback with a code, which core trades with the verifier only it
// holds. Core keeps the tokens as the owner-acts credential, never handing them on, and records his
// confirmation as his consent, the same fact his words in his room are (ISS-1013), naming the route
// `sign_in`. A sign-in is spent once; one past its time, refused by the product, declined by him, or
// whose binding no longer names the owner or the room is refused by name, and nothing is kept.

import { createHash } from 'node:crypto';
import type { SupportOwnerSignInRequest } from '@forge/contracts/support';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportOwnerConsents, supportOwnerSignIns } from '../db/schema-support.js';
import { decryptSecret, encryptSecret, isVaultConfigured } from '../integrations/index.js';
import { readSupportApis, type SupportApi } from '../integrations/support-api/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import {
  type OwnerRoom,
  ownerRoomOf,
  ownerUsername,
  productNamed,
  productsOf,
  standingConsent,
} from './owner-consent.js';
import { rewriteOwnerCredential } from './owner-credential.js';
import { ownerAuthorizationUrl, ownerOauthClient, tradeOwnerCode } from './owner-oauth.js';
import type { Refusal } from './refusals.js';
import { insertAction, type RoomRow, roomById } from './store.js';

/** How long the link the owner is handed stays good. */
export const OWNER_SIGN_IN_TTL_MS = 30 * 60_000;

const hashOf = (state: string) => createHash('sha256').update(state).digest('hex');

/** The callable product a sign-in is for, or the refusal naming why core cannot sign in to it. */
async function signInApi(projectId: string, bindingId: string): Promise<Outcome<SupportApi>> {
  const read = (await readSupportApis(projectId)).find(
    (r) => (r.ok ? r.api.bindingId : r.bindingId) === bindingId,
  );
  if (read?.ok) return { ok: true, value: read.api };
  return no(
    'SUPPORT_OWNER_SIGN_IN_UNDECLARED',
    '/product',
    read
      ? `the support-api binding of ${read.name} holds a configuration Forge cannot call (${read.fault}), so no sign-in was started`
      : 'the product this sign-in was for is no longer bound to the project, so nothing was kept',
  );
}

/** What the session is handed: the link to give the owner, and how long it stays good. */
export interface OwnerSignInStarted {
  product: string;
  url: string;
  expiresAt: string;
  says: string;
}

/**
 * Start the owner's sign-in to a product, from his own room. Refused by name, and nothing started,
 * anywhere else, for a product the project does not bind, or where the binding declares no sign-in.
 */
export async function startOwnerSignIn(
  room: RoomRow,
  input: SupportOwnerSignInRequest,
): Promise<Outcome<OwnerSignInStarted>> {
  const conversationId = await knownThread(room, input.thread);
  const refusedWith = async <T>(out: Outcome<T>) => {
    if (!out.ok && conversationId) {
      const [first] = out.refusals as Refusal[];
      await insertAction({
        roomId: room.id,
        projectId: room.projectId,
        conversationId,
        thread: input.thread,
        kind: 'refused',
        actorKind: 'core',
        tool: 'owner_sign_in',
        input: { product: input.product ?? null },
        output: { code: first?.code, detail: first?.detail, posted: false },
      });
    }
    return out as Outcome<never>;
  };
  const at = await ownerRoomOf(room, 'owner_sign_in');
  if (!at.ok) return refusedWith(at);
  if (!conversationId) return threadUnknown(input.thread);
  const product = productNamed(await productsOf(room.projectId), input.product);
  if (!product.ok) return refusedWith(product);
  const api = await signInApi(room.projectId, product.value.bindingId);
  if (!api.ok) return refusedWith(api);
  const client = ownerOauthClient(api.value.name, api.value.ownerSignIn, api.value.config);
  if (!client.ok) return refusedWith(client);
  if (!isVaultConfigured()) {
    return refusedWith(
      no(
        'SUPPORT_OWNER_CREDENTIAL_MISSING',
        '/product',
        'this Forge has no vault key (INTEGRATION_MASTER_KEY), so no credential of his could be kept; no sign-in was started',
      ),
    );
  }
  const started = await ownerAuthorizationUrl(client.value, api.value.ownerSignIn?.scopes ?? []);
  const expiresAt = new Date(Date.now() + OWNER_SIGN_IN_TTL_MS);
  const [row] = await db
    .insert(supportOwnerSignIns)
    .values({
      projectId: room.projectId,
      roomId: room.id,
      bindingId: api.value.bindingId,
      thread: input.thread,
      ownerKey: at.value.owner,
      stateHash: hashOf(started.state),
      verifierEnc: encryptSecret(started.verifier),
      expiresAt,
    })
    .returning({ id: supportOwnerSignIns.id });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'owner_sign_in',
    actorKind: 'session',
    tool: 'owner_sign_in',
    input: { product: api.value.name },
    output: { signIn: row?.id ?? null, expiresAt: expiresAt.toISOString() },
  });
  return {
    ok: true,
    value: {
      product: api.value.name,
      url: started.url,
      expiresAt: expiresAt.toISOString(),
      says: `give him this link in his own words, here in his room: he signs in to ${api.value.name} and confirms there before ${expiresAt.toISOString()}. Forge then keeps his credential, which you never see, and records his confirmation as his consent; owner_act works from then on.`,
    },
  };
}

/** What the owner's browser lands on: whether Forge keeps his sign-in now, and if not, why. */
export type OwnerSignInFinished =
  | { ok: true; product: string; consent: 'recorded' | 'stood' }
  | { ok: false; status: 400 | 404 | 409 | 410 | 502; why: string };

type SignInRow = typeof supportOwnerSignIns.$inferSelect;

const fail = (status: 400 | 404 | 409 | 410 | 502, why: string): OwnerSignInFinished => ({
  ok: false,
  status,
  why,
});

/** Settle a claimed sign-in with what came of it. */
async function settle(id: string, outcome: string): Promise<void> {
  await db
    .update(supportOwnerSignIns)
    .set({ outcome: outcome.slice(0, 500) })
    .where(eq(supportOwnerSignIns.id, id));
}

/**
 * The product sent the owner's browser back: check the state is a sign-in core started and has not
 * spent, still for the owner and room the binding names, trade the code, keep the tokens and record
 * his consent. Each refusal says why and what to do, and nothing is kept.
 */
export async function finishOwnerSignIn(query: {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}): Promise<OwnerSignInFinished> {
  if (!query.state) {
    return fail(400, 'This page was opened without the sign-in Forge started. Nothing was kept.');
  }
  const [row] = await db
    .select()
    .from(supportOwnerSignIns)
    .where(eq(supportOwnerSignIns.stateHash, hashOf(query.state)))
    .limit(1);
  if (!row) return fail(404, 'Forge started no such sign-in. Nothing was kept.');
  // claim it once: a second return with the same state, at once or later, finds it spent
  const [claimed] = await db
    .update(supportOwnerSignIns)
    .set({ completedAt: new Date(), outcome: 'trading' })
    .where(and(eq(supportOwnerSignIns.id, row.id), isNull(supportOwnerSignIns.completedAt)))
    .returning({ id: supportOwnerSignIns.id });
  const again = 'Ask your assistant for a new sign-in link in your room.';
  if (!claimed) return fail(409, `This sign-in link was already used. ${again}`);
  if (row.expiresAt.getTime() < Date.now()) {
    await settle(row.id, 'expired');
    return fail(410, `This sign-in link expired. ${again} Nothing was kept.`);
  }
  if (query.error) {
    await settle(row.id, `declined: ${query.error}`);
    return fail(
      400,
      `The sign-in was not confirmed (${query.error.slice(0, 100)}). Nothing was kept.`,
    );
  }
  if (!query.code) {
    await settle(row.id, 'no code');
    return fail(400, `The product sent no sign-in code back. ${again} Nothing was kept.`);
  }
  return trade(row, query.code, query.state, again);
}

async function trade(
  row: SignInRow,
  code: string,
  state: string,
  again: string,
): Promise<OwnerSignInFinished> {
  const room = await roomById(row.roomId);
  const at = room ? await ownerRoomOf(room, 'owner_sign_in') : null;
  if (!room || !at?.ok || at.value.owner !== row.ownerKey) {
    await settle(row.id, 'the room or its owner changed');
    return fail(
      409,
      'The room this sign-in was started in no longer acts for the same owner. Nothing was kept.',
    );
  }
  const api = await signInApi(row.projectId, row.bindingId);
  const client = api.ok
    ? ownerOauthClient(api.value.name, api.value.ownerSignIn, api.value.config)
    : api;
  if (!api.ok || !client.ok) {
    await settle(row.id, 'the binding no longer declares a usable sign-in');
    return fail(409, `The product's sign-in is no longer set up in Forge. Nothing was kept.`);
  }
  const answer = await tradeOwnerCode(client.value, {
    code,
    state,
    verifier: decryptSecret(row.verifierEnc),
  });
  if (answer.kind !== 'ok') {
    await settle(row.id, `${answer.kind}: ${answer.reason}`);
    return fail(
      502,
      `${api.value.name} did not complete the sign-in (${answer.reason}). ${again} Nothing was kept.`,
    );
  }
  const consent = await keepSignedIn(room, at.value, row, api.value, answer.tokens);
  return { ok: true, product: api.value.name, consent };
}

/** Keep the tokens and record his consent by sign-in, in one transaction under the binding's lock. */
async function keepSignedIn(
  room: RoomRow,
  at: OwnerRoom,
  row: SignInRow,
  api: SupportApi,
  tokens: { accessToken: string; refreshToken: string | undefined; expiresAt: string | null },
): Promise<'recorded' | 'stood'> {
  const conversationId = await knownThread(room, row.thread);
  const label = await ownerUsername(room.projectId, at.owner);
  const standing = await standingConsent(room.id, api.bindingId);
  return db.transaction(async (tx) => {
    await lockXact(tx, 'supportOwnerCredential', `${room.projectId}:${api.bindingId}`);
    await rewriteOwnerCredential(tx, {
      projectId: room.projectId,
      bindingId: api.bindingId,
      value: {
        oauth: {
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          expiresAt: tokens.expiresAt,
        },
      },
      why: `kept: the owner confirmed the sign-in Forge started (${row.id})`,
    });
    await tx
      .update(supportOwnerSignIns)
      .set({ outcome: 'kept' })
      .where(eq(supportOwnerSignIns.id, row.id));
    const fact = { product: api.name, route: 'sign_in', signIn: row.id };
    const base = {
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: row.thread,
      actorKind: 'member' as const,
      actorKey: at.owner,
      actorLabel: label,
      tool: 'owner_sign_in',
    };
    await insertAction(
      { ...base, kind: 'owner_signed_in', input: fact, output: { kept: true } },
      tx,
    );
    if (standing) return 'stood';
    // his word in the room may have been recorded while he signed in: that one stands, and this adds none
    const [made] = await tx
      .insert(supportOwnerConsents)
      .values({
        projectId: room.projectId,
        roomId: room.id,
        bindingId: api.bindingId,
        ownerKey: at.owner,
        ownerLabel: label,
        thread: row.thread,
        route: 'sign_in',
        givenMessage: null,
      })
      .onConflictDoNothing()
      .returning({ id: supportOwnerConsents.id });
    if (!made) return 'stood';
    await insertAction(
      {
        ...base,
        kind: 'owner_consented',
        input: { ...fact, citedBy: 'core' },
        output: { consent: made.id, bindingId: api.bindingId },
      },
      tx,
    );
    return 'recorded';
  });
}
