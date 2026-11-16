// The doors agents are given (ISS-1251), as one catalog every reader takes from the same place: the
// MCP actions the registry serves and the REST routes the published API contract lists. The MCP door
// builds it and the composition root hands it here, so a read model or another door counts and checks
// against it without importing the MCP door, and nobody keeps a list of doors by hand.

import {
  type CapabilityCard,
  type CardAudience,
  TIER0_MAP_MAX_CHARS,
} from '@forge/contracts/capability-cards';
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
  /** The repository paths its door lives in (a file or a module's directory); empty where unknown. */
  paths?: readonly string[];
}

export interface DoorCatalog {
  doors: readonly CatalogDoor[];
  /** The door a logged call names, or null where the catalog holds none for it. */
  doorOf(call: { tool: string; action: string | null }): CatalogDoor | null;
}

const slot = portSlot<{ doorCatalog(): DoorCatalog }>('door-catalog', 'provideDoorCatalog');
export const provideDoorCatalog = slot.provide;
export const doorCatalog = (): DoorCatalog => slot.get().doorCatalog();

/** The paths a card's door lives in: a landing touching one owes the card a re-check. */
export const cardPaths = (cardId: string): readonly string[] =>
  doorCatalog().doors.find((d) => d.card?.id === cardId)?.paths ?? [];

/** One audience's Tier-0 map: its text, the cards it carries, and how many cards teach that audience. */
export interface Tier0Map {
  text: string;
  /** The card ids the map carries; every other card of the audience is Tier 1 (found by situation). */
  carried: readonly string[];
  reach: number;
}

/**
 * The Tier-0 map of one audience (ISS-1251): one line per situation, "when X → door", of the cards
 * that teach it, most used first (`calls`, the door use of the window), as many whole cards as fit in
 * `TIER0_MAP_MAX_CHARS`. The rest are Tier 1, reached by situation through `forge_find`; a card is
 * never cut to fit, and a map that cannot carry every card is a pile due for merging.
 */
export function tier0Map(
  doors: readonly CatalogDoor[],
  audience: CardAudience,
  proposed: ReadonlyMap<string, readonly string[]> = new Map(),
  calls: ReadonlyMap<string, number> = new Map(),
): Tier0Map {
  const taught = doors
    .filter((d) => d.card?.audience.includes(audience))
    .sort((a, b) => (calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const lines: string[] = [];
  const carried: string[] = [];
  let size = -1;
  for (const d of taught) {
    const card = d.card as CapabilityCard;
    const block = [
      ...card.situations.map((s) => `- when ${s.when} → ${d.id}`),
      // a situation a lesson folded in, shown until the card's code carries it
      ...(proposed.get(card.id) ?? []).map((t) => `- (proposed) ${t} → ${d.id}`),
    ];
    const grows = block.join('\n').length + 1;
    if (size + grows > TIER0_MAP_MAX_CHARS) continue;
    size += grows;
    lines.push(...block);
    carried.push(card.id);
  }
  return { text: lines.join('\n'), carried, reach: taught.length };
}
