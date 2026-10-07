import { TOUR_KEY_PREFIX, type TourStateValue } from "@forge/contracts/product-state";
import type { ProductStateView } from "@forge/contracts/product-state";
import type { TourDefinition } from "./registry";

/** How a person stands with a tour at its revision: finished it, not yet, or finished an older revision. */
export type TourStanding = "seen" | "not_seen" | "updated";

export const tourKey = (id: string) => `${TOUR_KEY_PREFIX}${id}` as const;

/** Each tour's stored outcome, by tour id, from the person's product state. */
export function tourStatesOf(items: readonly ProductStateView[]): Map<string, TourStateValue> {
  const out = new Map<string, TourStateValue>();
  for (const item of items) {
    if (item.key.startsWith(TOUR_KEY_PREFIX) && item.value) {
      out.set(item.key.slice(TOUR_KEY_PREFIX.length), item.value as TourStateValue);
    }
  }
  return out;
}

export function standingOf(tour: TourDefinition, state: TourStateValue | undefined): TourStanding {
  if (!state) return "not_seen";
  if (state.revision < tour.revision) return "updated";
  return state.outcome === "completed" ? "seen" : "not_seen";
}

/** Whether the page offers the tour inline: never left at this revision, finished or set aside. */
export function offersHint(tour: TourDefinition, state: TourStateValue | undefined): boolean {
  return !state || state.revision < tour.revision;
}
