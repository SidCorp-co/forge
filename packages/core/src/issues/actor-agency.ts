export type ActorAgency = 'human' | 'agent';

/** The agency an audit row records. A user carries its own, from `users.kind`. */
export function actorAgency(actor: {
  type: 'user' | 'device';
  agency?: ActorAgency | undefined;
}): ActorAgency {
  if (actor.type === 'device') return 'agent';
  return actor.agency ?? 'human';
}

export type DeviceLite = { id: string; ownerId: string };

/** A person or an agent account acting through a credential; `deviceId` is the box that credential
 *  was issued to, where it names one (a checkout's workspace credential does). */
export type UserActor = {
  type: 'user';
  id: string;
  agency?: ActorAgency | undefined;
  deviceId?: string | undefined;
};

export type TransitionActor = UserActor | ({ type: 'device' } & DeviceLite);

/**
 * The actor a credential acts as, built the same way by every door — REST and MCP — so a write
 * reads the same whichever door it came through (ISS-1228 round 22): the account the credential
 * belongs to, that account's agency, and the box the credential was issued to where it names one.
 */
export function credentialActor(credential: {
  userId: string;
  agency: ActorAgency;
  deviceId: string | null | undefined;
}): UserActor & { agency: ActorAgency } {
  return {
    type: 'user',
    id: credential.userId,
    agency: credential.agency,
    ...(credential.deviceId ? { deviceId: credential.deviceId } : {}),
  };
}
