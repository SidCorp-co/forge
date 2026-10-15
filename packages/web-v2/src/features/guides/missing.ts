// The words for an unknown guide, page or door, said by two renderers: docs/modules/guides/public-pages.md.
import { coreFileUrl } from "@/lib/utils/core-url";
import { AUDIENCES, DOORS } from "./audience";

export function missingGuideHeading(slug: string): string {
  return slug
    ? `Forge publishes no guide called “${slug}”`
    : "Forge publishes no guide at that address";
}

export const MISSING_GUIDE_BODY = `The index lists every guide there is, and each one is also readable as markdown at ${coreFileUrl(
  "/api/guides",
)}/<slug>.md with no credential.`;

/** Said where a refusal would offer the docs' search and the guide index it searches is down. */
export const SEARCH_UNAVAILABLE = "Search is not available right now: the guide index could not be reached.";

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

/** Said, while the guide index is down, above the bundled doors and under a bundled page's search. */
export const BUNDLED_WAYS_IN = "These ways in are built into this site and open without it:";
export const HELP_ONLY_SEARCH =
  "Search covers the pages for people only: the pages for agents could not be loaded.";

/** What a refusal says while the guide index does not answer, one paragraph each. */
export function saidWhileDown(refusal: Refusal): string[] {
  const why = refusal === GUIDES_UNAVAILABLE ? null : SEARCH_UNAVAILABLE;
  return [refusal.bodyWhileDown, why, BUNDLED_WAYS_IN].filter((p): p is string => p !== null);
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

export function missingDoor(value: string): Refusal {
  const body = `A door is one of ${AUDIENCES.map((a) => `“${a}” (${DOORS[a].label})`).join(", ")}.`;
  return {
    heading: value ? `The documentation has no door called “${value}”` : "The link you followed names no door",
    body,
    bodyWhileDown: body,
  };
}

const ONE_AT_A_TIME = "Open the page on its own, or the door on its own.";

export const PAGE_AND_DOOR: Refusal = {
  heading: "An address names a page or a door, not both",
  body: `${ONE_AT_A_TIME} ${PICK_FROM_INDEX}`,
  bodyWhileDown: ONE_AT_A_TIME,
};
