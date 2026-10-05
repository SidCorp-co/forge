// Why a turn runs at all. A message turn answers the person who spoke and acts as them. The one
// other origin, the onboarding hand-off (project-onboarding `req-case`), is the BA drafting first
// requirements unprompted once every onboarding design is approved: it runs only in that case room
// and may only read the journeys and propose suggestions, each of which still waits on a person's
// accept. Any other act from it is refused by name.

import type { TurnAuthorityRefusalCode } from '@forge/contracts/auth';
import type { TurnAuthorityRefusal, TurnOrigin } from '../credentials/turn-credential.js';
import { refuser } from '../lib/refusal.js';
import { firstRequirementsOnboardingOf } from '../onboarding/index.js';
import { type ChatToolset, toolError } from './tools/mcp-adapter.js';

/** What a hand-off turn may call: the journey and dedup reads, and the suggestion. */
export const ONBOARDING_HANDOFF_ACTS = [
  'ba_read_journeys',
  'ba_find_similar',
  'ba_suggest_requirement',
] as const;

const HANDOFF_ACTS: ReadonlySet<string> = new Set(ONBOARDING_HANDOFF_ACTS);

const refuse = refuser<TurnAuthorityRefusalCode>('TURN_ORIGIN_REFUSED');

/** The refusal thrown where a turn's origin forbids it; the room is shown its sentence. */
export const turnOriginRefused = (r: TurnAuthorityRefusal) => refuse(r.code, r.message);

/** The hand-off runs in a first-requirements case room and nowhere else. */
export function handoffVenueRefusal(
  externalId: string | null | undefined,
): TurnAuthorityRefusal | null {
  if (firstRequirementsOnboardingOf(externalId)) return null;
  return {
    code: 'TURN_ORIGIN_REFUSED',
    message:
      'I will not act on this: an onboarding hand-off turn runs only in the first-requirements room it was opened for, and this is another room.',
  };
}

/** A person spoke in the hand-off window, so the turn answers them as a message turn. */
export function handoffPersonSpoke(
  messages: readonly { role: string; authorUserId: string | null }[],
): boolean {
  return messages.some((m) => m.role === 'user' && m.authorUserId !== null);
}

/** The catalog an origin may call; a hand-off keeps only its acts and refuses the rest by name. */
export function fenceToolsetToOrigin(set: ChatToolset, origin: TurnOrigin): ChatToolset {
  if (origin === 'message') return set;
  return {
    tools: set.tools.filter((t) => HANDOFF_ACTS.has(t.function.name)),
    execute: async (name, argsJson) =>
      HANDOFF_ACTS.has(name)
        ? set.execute(name, argsJson)
        : toolError(
            `TURN_ORIGIN_REFUSED: "${name}" is not an act of an onboarding hand-off turn, which may only call ${ONBOARDING_HANDOFF_ACTS.join(', ')}. A person asks for anything else in the room.`,
          ),
    ranAs: (name) => (HANDOFF_ACTS.has(name) ? set.ranAs(name) : null),
  };
}
