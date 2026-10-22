import type { ActorAgency } from '@forge/contracts/permissions';
import type { KernelActor } from '../lifecycle/index.js';
import type { McpPrincipal } from '../middleware/require-pat.js';

/** The agency an audit row records: a device's is `agent`, a user's is its door's, and none is refused. */
export function actorAgency(actor: {
  type: 'user' | 'device';
  agency?: ActorAgency | undefined;
}): ActorAgency {
  if (actor.type === 'device') return 'agent';
  if (actor.agency === undefined) throw agencyUndetermined();
  return actor.agency;
}

/** A user actor carried no agency, so who acted cannot be recorded without a guess: an invariant. */
export function agencyUndetermined(): Error {
  return new Error(
    'a user actor reached the audit with no agency, so whether a person or an agent acted is not known; the door that admitted the request sets it (requireAuth, requireUserOrDevice or the MCP principal)',
  );
}

export type DeviceLite = { id: string; ownerId: string };

export type TransitionActor =
  | { type: 'user'; id: string; agency: ActorAgency }
  | ({ type: 'device' } & DeviceLite);

/** Who was at the keyboard for an agent-tool call: a paired box is an agent, a token its own agency. */
export function principalAgency(principal: McpPrincipal): ActorAgency {
  return principal.deviceId ? 'agent' : actorAgency({ type: 'user', agency: principal.agency });
}

/**
 * ISS-1107 — the transition actor as `kernel_transitions` stores one. The two
 * vocabularies differ: `TransitionActor` has `device`, which
 * `kernelTransitionActorTypes` has not, and a device IS a runner box, so it
 * records under that type carrying its own id. `agency` goes through
 * `actorAgency` rather than a spread — `null` is an agent-driven user there and
 * `undefined` is a human.
 */
export function kernelActorFor(actor: TransitionActor): KernelActor {
  if (actor.type === 'user') {
    return { type: 'user', id: actor.id, agency: actorAgency(actor) };
  }
  return { type: 'runner', id: actor.id };
}
