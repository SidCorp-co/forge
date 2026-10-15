// The words for an unknown guide, page or door, said by two renderers: docs/modules/guides/public-pages.md.
import { coreFileUrl } from "@/lib/utils/core-url";
import { AUDIENCES, type Audience, BUNDLED_AUDIENCES, DOORS, doorHref, INDEX_PATH, openDoors, pagesOf, searchLabel } from "./audience";

export function missingGuideHeading(slug: string): string {
  return slug
    ? `Forge publishes no guide called “${slug}”`
    : "Forge publishes no guide at that address";
}

export const MISSING_GUIDE_BODY = `The index lists every guide there is, and each one is also readable as markdown at ${coreFileUrl(
  "/api/guides",
)}/<slug>.md with no credential.`;

/** The way back from a refusal that is not one of the three doors themselves. */
export const ALL_DOORS_LINK_TEXT = "All three ways in";

/** A refusal of an address on the public documentation: what it says, twice, and while the guide
 *  index is down (`null` where `body` only points at that index). */
export interface Refusal {
  heading: string;
  body: string;
  bodyWhileDown: string | null;
}

const GUIDES_UNAVAILABLE_BODY = "This page is built from Forge's guide index, which did not answer. Try again in a moment.";

/** Said in place of the landing, the agents' door or an agent page when the guide index is down. */
export const GUIDES_UNAVAILABLE: Refusal = {
  heading: "The guides could not be loaded",
  body: GUIDES_UNAVAILABLE_BODY,
  bodyWhileDown: GUIDES_UNAVAILABLE_BODY,
};

const CLOSED_WHILE_DOWN = AUDIENCES.filter((a) => !BUNDLED_AUDIENCES.includes(a));

export const LANDING_WHILE_DOWN = "Forge's guide index did not answer. The pages built into this site open without it.";

/** What every page says about its search while the guide index is down: the landing's and a bundled
 *  page's search still answer, over the bundled pages alone, and a refusal links the landing's. */
export const SEARCH_WHILE_DOWN = `Search covers ${pagesOf(BUNDLED_AUDIENCES)} only: ${pagesOf(CLOSED_WHILE_DOWN)} could not be loaded.`;

/** Said, while the guide index is down, above a refusal's ways in. */
export const BUNDLED_WAYS_IN = "These ways in are built into this site and open without it:";

/** What a refusal says while the guide index does not answer, one paragraph each. */
export function saidWhileDown(refusal: Refusal): string[] {
  return [refusal.bodyWhileDown, SEARCH_WHILE_DOWN, BUNDLED_WAYS_IN].filter((p): p is string => p !== null);
}

/** The links a refusal offers as the way on: the doors that open, then the landing — under the name
 *  of its search while the index is down, since that search still answers and nothing else on it does. */
export function waysIn(indexDown: boolean): ReadonlyArray<{ href: string; label: string }> {
  const open = openDoors(indexDown);
  return [
    ...open.map((a) => ({ href: doorHref(a), label: DOORS[a].label })),
    { href: INDEX_PATH, label: indexDown ? searchLabel(open) : ALL_DOORS_LINK_TEXT },
  ];
}

const PICK_FROM_INDEX = "The index lists every page behind each of its three doors.";

export function missingGuide(slug: string): Refusal {
  return { heading: missingGuideHeading(slug), body: MISSING_GUIDE_BODY, bodyWhileDown: null };
}

export function missingPage(slug: string): Refusal {
  return {
    heading: slug ? `Forge publishes no page called “${slug}”` : "The link you followed names no page",
    body: PICK_FROM_INDEX,
    bodyWhileDown: null,
  };
}

function doorNames(doors: readonly Audience[]): string {
  return doors.map((a) => `“${a}” (${DOORS[a].label})`).join(", ");
}

export function missingDoor(value: string): Refusal {
  return {
    heading: value ? `The documentation has no door called “${value}”` : "The link you followed names no door",
    body: `A door is one of ${doorNames(AUDIENCES)}.`,
    bodyWhileDown: `The doors that open now are ${doorNames(openDoors(true))}.`,
  };
}

const ONE_AT_A_TIME = "Open the page on its own, or the door on its own.";

export const PAGE_AND_DOOR: Refusal = {
  heading: "An address names a page or a door, not both",
  body: `${ONE_AT_A_TIME} ${PICK_FROM_INDEX}`,
  bodyWhileDown: ONE_AT_A_TIME,
};
