// The doors agents are given (ISS-1251), as one catalog every reader takes from the same place: the
// MCP actions the registry serves and the REST routes the published API contract lists. The MCP door
// builds it and the composition root hands it here, so a read model or another door counts and checks
// against it without importing the MCP door, and nobody keeps a list of doors by hand.

import type { CapabilityCard, CardAudience } from '@forge/contracts/capability-cards';
import type { DoorSurface } from '@forge/contracts/door-use';
import { portSlot } from './port-slot.js';

/** One door: what it is called, where it is served, what it is for and the feature that owns it. */
export interface CatalogDoor {
  /** `<door>.<action>` (MCP) or `METHOD /path` with the contract's `:param` template (REST). */
  id: string;
  surface: DoorSurface;
  /** One line from the door's own guide; null where the source holds none. */
  summary: string | null;
  /** The MCP tool and its REST twin, or the route's resource (`/api/projects/:id/feedback`). */
  feature: string;
  /** What teaches the door: its capability card, where one is written (ISS-1251). */
  card?: CapabilityCard;
}

export interface DoorCatalog {
  doors: readonly CatalogDoor[];
  /** The door a logged call names, or null where the catalog holds none for it. */
  doorOf(call: { tool: string; action: string | null }): CatalogDoor | null;
}

const slot = portSlot<{ doorCatalog(): DoorCatalog }>('door-catalog', 'provideDoorCatalog');
export const provideDoorCatalog = slot.provide;
export const doorCatalog = (): DoorCatalog => slot.get().doorCatalog();

/**
 * The Tier-0 map of one audience (ISS-1251): one line per situation of every card that teaches it,
 * "when X → door", which an agent carries every turn and opens the card from when the situation
 * arises. It is never cut to fit: a map past `TIER0_MAP_MAX_CHARS` is a pile due for merging.
 */
export function tier0Map(doors: readonly CatalogDoor[], audience: CardAudience): string {
  return doors
    .flatMap((d) =>
      d.card?.audience.includes(audience)
        ? d.card.situations.map((s) => `- when ${s.when} → ${d.id}`)
        : [],
    )
    .join('\n');
}
