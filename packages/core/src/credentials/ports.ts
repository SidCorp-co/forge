// What the credentials module needs from the kernel above it, handed in by the process entry at
// boot: a platform module may not import the outbox, so a token change reaches it through here.

import { portSlot } from '../lib/port-slot.js';

interface CredentialsPorts {
  /** Writes the `credential.tokenChanged` outbox event the WebSocket door pushes from. */
  tokenChanged(change: {
    userId: string;
    tokenId: string;
    change: 'created' | 'revoked' | 'used';
    ts: string;
  }): Promise<void>;
}

const slot = portSlot<CredentialsPorts>('credentials', 'provideCredentialsPorts');
export const provideCredentialsPorts = slot.provide;
export const tokenChanged = slot.port('tokenChanged');
