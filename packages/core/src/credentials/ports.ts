// What the credentials module needs from the kernel above it, handed in by the process entry at
// boot: a platform module may not import the outbox, so a token change reaches it through here, nor
// the sessions a box runs, so the session a box credential's act was made in is named through here.

import { portSlot } from '../lib/port-slot.js';

interface CredentialsPorts {
  /** Writes the `credential.tokenChanged` outbox event the WebSocket door pushes from. */
  tokenChanged(change: {
    userId: string;
    tokenId: string;
    change: 'created' | 'revoked' | 'used' | 'fenced';
    ts: string;
  }): Promise<void>;
  /**
   * The session a box credential's act was made in, named as its reads are
   * (`run-context-ports.ts:runOfCall`); null where none can be named (ISS-1251).
   */
  actSessionOf(caller: {
    deviceId: string;
    tokenId: string;
    projectId: string;
    fence: readonly string[] | null;
    asked: string | null;
  }): Promise<string | null>;
}

const slot = portSlot<CredentialsPorts>('credentials', 'provideCredentialsPorts');
export const provideCredentialsPorts = slot.provide;
export const tokenChanged = slot.port('tokenChanged');
export const actSessionOf = slot.port('actSessionOf');
