/**
 * ISS-987 — whose authority a Rocket.Chat turn runs under.
 *
 * The answer follows from the room's shape rather than from whatever field is
 * nearest, and it is read by the connection manager on every handled message.
 * Which conversation the message belongs to moved to
 * `conversation-port.ts:rocketChatVenueId`, where the server is part of the key.
 */

import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker, unlinkedMessage } from '../../assistant/identity/speaker-link.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import type { RoomShape } from './room-shape.js';

export type TurnPrincipal = { ok: true; userId: string } | { ok: false; refusal: string };

/**
 * Whose authority this turn runs under. A direct room has exactly one human and
 * runs as them; a group room has many speakers and no single authority, so it
 * keeps the organization's creator.
 */
// cm:why a group room is left on the organization's creator DELIBERATELY, and the price is stated rather than discovered: a person in a channel who is not a project collaborator receives answers computed with the creator's read access. Re-pointing it at whoever spoke last is a decision about what a channel binding grants, which ISS-987 put out of scope on purpose.
export async function resolveTurnPrincipal(args: {
  serverUrl: string;
  routePrincipalUserId: string;
  projectId: string;
  m: RocketChatIncomingMessage;
  shape: RoomShape;
  onRefusal?: (detail: { code: string; rid: string; projectId: string }) => void;
}): Promise<TurnPrincipal> {
  if (args.shape !== 'direct') return { ok: true, userId: args.routePrincipalUserId };
  const namespace = namespaceFromServerUrl(args.serverUrl);
  if (!namespace) {
    return {
      ok: false,
      refusal: `This Rocket.Chat server's address (${args.serverUrl}) cannot be read as a channel identity, so nothing can be answered as you here.`,
    };
  }
  const ref = {
    source: 'rocketchat',
    namespace,
    externalId: args.m.userId,
    label: args.m.username ?? null,
  };
  const resolution = await resolveSpeaker(ref);
  if (!resolution.linked) {
    args.onRefusal?.({
      code: resolution.refusal.code,
      rid: args.m.rid,
      projectId: args.projectId,
    });
    // cm:why the unlinked refusal carries ISS-977's own text, not a local rewording: the way out (the two endpoints, and that the person links themselves rather than an admin doing it for them) is the contract that module owns, and a second copy here drifts from it silently
    return {
      ok: false,
      refusal:
        resolution.refusal.code === 'SPEAKER_UNLINKED'
          ? unlinkedMessage(ref)
          : resolution.refusal.message,
    };
  }
  return { ok: true, userId: resolution.userId };
}
