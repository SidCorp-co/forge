// The owner's headers for one act, refreshed first where they need it (ISS-1047, REQ-85 BC-2, BC-4).
// A credential core keeps as static headers is sent as it is (ISS-1013). One kept as OAuth tokens is
// sent as `Authorization: Bearer <access token>` while the access token has more than a minute
// left; otherwise core spends the refresh token at the product's token endpoint first and stores
// the pair the product answers, so a product whose refresh tokens are single-use and rotate (as
// Agenfold's are: an access token lives an hour, a refresh token thirty days) keeps working.
//
// A refresh token must never be spent twice, so every refresh runs under one lock per binding and
// re-reads the stored pair once it holds it: a second act that waited finds the rotation done and
// sends its result. A refresh the product refuses ends the credential by name, keeping no token,
// and the act is refused saying who signs in again and where; a dead token is never sent.

import type { SupportOwnerCredential, SupportOwnerOauth } from '@forge/contracts/support';
import { db } from '../db/client.js';
import type { SupportApi } from '../integrations/support-api/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { ownerOauthClient, refreshOwnerTokens } from './owner-oauth.js';
import {
  ownerCredentialValuesOf,
  readOwnerCredential,
  rewriteOwnerCredential,
} from './owner-credential.js';
import { no, type Outcome } from './outcome.js';

/** An access token with less than this left is refreshed before it is sent. */
export const OWNER_REFRESH_MARGIN_MS = 60_000;

/** The headers an act goes out with, and every credential value its answer is scrubbed of. */
export interface OwnerHeaders {
  headers: Record<string, string>;
  secrets: string[];
}

/** What a refusal says, in the words of the room it is made in. */
export interface OwnerWords {
  /** Who keeps the credential at its door: `a project admin (…) keeps it`. */
  keeper: string;
  /** Who signs in again, and where: `only @alice, …, in his own room …`. */
  signsInAgain: string;
}

const bearer = (oauth: SupportOwnerOauth): OwnerHeaders => ({
  headers: { Authorization: `Bearer ${oauth.accessToken}` },
  secrets: ownerCredentialValuesOf({ oauth }),
});

/** Milliseconds the access token has left; null where the product never said when it expires. */
const leftOf = (oauth: SupportOwnerOauth, now: number): number | null =>
  oauth.expiresAt === null ? null : Date.parse(oauth.expiresAt) - now;

/** Fresh enough to send as it is: an expiry known and more than the margin away. */
const freshEnough = (oauth: SupportOwnerOauth, now: number) => {
  const left = leftOf(oauth, now);
  return left !== null && left > OWNER_REFRESH_MARGIN_MS;
};

/** Not yet past its expiry, where a refresh could not be made: sendable, though due. */
const unexpired = (oauth: SupportOwnerOauth, now: number) => {
  const left = leftOf(oauth, now);
  return left !== null && left > 0;
};

function signInAgain(
  projectId: string,
  bindingId: string,
  product: string,
  why: string,
  words: OwnerWords,
): Outcome<OwnerHeaders> {
  return no(
    'SUPPORT_OWNER_SIGN_IN_AGAIN',
    '/tool',
    `the owner's credential for ${product} ended (${why}), so nothing was sent and the room cannot act as him there until he signs in again: ${words.signsInAgain}, where you start it with owner_sign_in and hand him the link; or ${words.keeper} at PUT /api/projects/${projectId}/support/owner-credentials/${bindingId}.`,
  );
}

/**
 * The owner's headers for one act in `api`'s product, refreshed first where they need it; or the
 * refusal naming why none can be sent and who acts next.
 */
export async function ownerHeadersFor(input: {
  projectId: string;
  api: SupportApi;
  words: OwnerWords;
}): Promise<Outcome<OwnerHeaders>> {
  const { projectId, api, words } = input;
  const kept = await readOwnerCredential(projectId, api.bindingId);
  if (!kept.ok) {
    const why = {
      missing: `Forge keeps no owner credential for ${api.name}`,
      unreadable: `the owner credential Forge keeps for ${api.name} cannot be opened with this core's vault key`,
      malformed: `the owner credential Forge keeps for ${api.name} is neither { headers } nor { oauth } as the door writes it`,
    }[kept.why];
    return no(
      'SUPPORT_OWNER_CREDENTIAL_MISSING',
      '/tool',
      `${why}, so nothing was sent to ${api.name}. To keep it, ${words.keeper} at PUT /api/projects/${projectId}/support/owner-credentials/${api.bindingId}; or the owner signs in: ${words.signsInAgain}, where you start it with owner_sign_in.`,
    );
  }
  const value = kept.value;
  if ('headers' in value) {
    return { ok: true, value: { headers: value.headers, secrets: ownerCredentialValuesOf(value) } };
  }
  if ('ended' in value) {
    return signInAgain(projectId, api.bindingId, api.name, value.ended.reason, words);
  }
  if (freshEnough(value.oauth, Date.now())) return { ok: true, value: bearer(value.oauth) };
  return refreshUnderLock(input);
}

/** Refresh the owner's pair under the binding's lock, once, whoever else waits on it. */
function refreshUnderLock(input: {
  projectId: string;
  api: SupportApi;
  words: OwnerWords;
}): Promise<Outcome<OwnerHeaders>> {
  const { projectId, api, words } = input;
  return db.transaction(async (tx) => {
    await lockXact(tx, 'supportOwnerCredential', `${projectId}:${api.bindingId}`);
    // read again under the lock: an act that held it before this one may have rotated the pair
    const kept = await readOwnerCredential(projectId, api.bindingId);
    if (!kept.ok || !('oauth' in kept.value)) {
      // dropped, replaced or ended while this act waited: answered as the stored value now says
      return ownerHeadersAfter(kept, input);
    }
    const now = Date.now();
    const oauth = kept.value.oauth;
    if (freshEnough(oauth, now)) return { ok: true, value: bearer(oauth) };

    const end = async (reason: string): Promise<Outcome<OwnerHeaders>> => {
      const ended: SupportOwnerCredential = { ended: { at: new Date(now).toISOString(), reason } };
      await rewriteOwnerCredential(tx, {
        projectId,
        bindingId: api.bindingId,
        value: ended,
        why: `ended: ${reason}`,
      });
      logger.warn(
        { projectId, bindingId: api.bindingId, reason },
        'support: the owner credential ended; he signs in again',
      );
      return signInAgain(projectId, api.bindingId, api.name, reason, words);
    };

    if (!oauth.refreshToken) {
      if (unexpired(oauth, now)) return { ok: true, value: bearer(oauth) };
      return end('the access token expired, and no refresh token is kept to renew it');
    }
    const client = ownerOauthClient(api.name, api.ownerSignIn, api.config);
    if (!client.ok) {
      if (unexpired(oauth, now)) return { ok: true, value: bearer(oauth) };
      return client;
    }
    const answer = await refreshOwnerTokens(client.value, oauth.refreshToken);
    if (answer.kind === 'transient') {
      logger.warn(
        { projectId, bindingId: api.bindingId, reason: answer.reason },
        'support: the owner token refresh was not answered; the stored pair is kept',
      );
      if (unexpired(oauth, now)) return { ok: true, value: bearer(oauth) };
      return no(
        'SUPPORT_OWNER_TOKEN_UNANSWERED',
        '/tool',
        `the owner's access token for ${api.name} expired and its token endpoint gave no answer to renew it (${answer.reason}), so nothing was sent; his credential is kept as it was, and the act can be asked again.`,
      );
    }
    if (answer.kind === 'refused') {
      return end(`${api.name} refused its refresh: ${answer.reason}`);
    }
    const next: SupportOwnerOauth = {
      accessToken: answer.tokens.accessToken,
      ...(answer.tokens.refreshToken ? { refreshToken: answer.tokens.refreshToken } : {}),
      expiresAt: answer.tokens.expiresAt,
    };
    await rewriteOwnerCredential(tx, {
      projectId,
      bindingId: api.bindingId,
      value: { oauth: next },
      why: 'refreshed: the product answered a new access token and refresh token',
    });
    return {
      ok: true,
      value: {
        headers: bearer(next).headers,
        // the spent pair too: a product may echo either, and neither is ever handed on
        secrets: [...ownerCredentialValuesOf({ oauth: next }), ...ownerCredentialValuesOf(kept.value)],
      },
    };
  });
}

/** The headers as a value read under the lock says, where it is no longer an OAuth pair. */
async function ownerHeadersAfter(
  kept: Awaited<ReturnType<typeof readOwnerCredential>>,
  input: { projectId: string; api: SupportApi; words: OwnerWords },
): Promise<Outcome<OwnerHeaders>> {
  if (kept.ok && 'headers' in kept.value) {
    return {
      ok: true,
      value: { headers: kept.value.headers, secrets: ownerCredentialValuesOf(kept.value) },
    };
  }
  if (kept.ok && 'ended' in kept.value) {
    return signInAgain(
      input.projectId,
      input.api.bindingId,
      input.api.name,
      kept.value.ended.reason,
      input.words,
    );
  }
  return ownerHeadersFor(input);
}
