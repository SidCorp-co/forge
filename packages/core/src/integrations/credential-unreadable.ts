import { HTTPException } from 'hono/http-exception';
import { providerLabel } from './health-words.js';
import type { HealthCheckResult } from './types.js';

/** Which stored credential could not be opened: identified by where it lives, never by what it holds. */
export interface UnreadableCredential {
  connectionId: string;
  provider: string;
  displayName: string | null;
  /** The binding it was read through, where it was read through one. */
  bindingId?: string;
}

export const CREDENTIAL_UNREADABLE = 'CREDENTIAL_UNREADABLE';

export const UNREADABLE_WHEN = "the stored credential cannot be decrypted with this server's key";

const REENTER =
  "Enter the credential again to replace it. If every connection says this at once, this server's INTEGRATION_MASTER_KEY changed.";

/** What to do when nothing of the stored credential can be kept: the whole of it, sent again. */
export const SEND_WHOLE =
  'None of it can be kept, so send the whole credential again rather than part of it.';

function credentialWords(credential: UnreadableCredential, clears: string): string {
  const named = credential.displayName ? ` "${credential.displayName}"` : '';
  const through = credential.bindingId ? `, read through binding ${credential.bindingId}` : '';
  return (
    `The stored credential of the ${providerLabel(credential.provider)} connection${named} ` +
    `(connection ${credential.connectionId}${through}) could not be decrypted with the key this ` +
    `server holds, so it was not used. ${clears}`
  );
}

/**
 * An `HTTPException`, so every HTTP door that reads one answers `409 CREDENTIAL_UNREADABLE` and not
 * `500 INTERNAL_ERROR`; any other reader carries the same named message into what it records.
 */
export class CredentialUnreadable extends HTTPException {
  readonly credential: UnreadableCredential;

  constructor(credential: UnreadableCredential, clears: string = REENTER) {
    const { connectionId, provider, bindingId } = credential;
    super(409, {
      message: credentialWords(credential, clears),
      cause: {
        code: CREDENTIAL_UNREADABLE,
        details: { connectionId, provider, ...(bindingId ? { bindingId } : {}) },
      },
    });
    this.name = 'CredentialUnreadable';
    this.credential = credential;
  }
}

/** A failed check, as the ssh-key Test answers `key_unreadable`: the check ran and found this. */
export function unreadableHealth(err: CredentialUnreadable): HealthCheckResult {
  const { connectionId, provider, bindingId } = err.credential;
  return {
    status: 'error',
    message: err.message,
    diagnostics: {
      code: 'credential_unreadable',
      connectionId,
      provider,
      ...(bindingId ? { bindingId } : {}),
    },
  };
}
