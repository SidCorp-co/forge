// The words for an unknown guide, page or door, said by two renderers: docs/modules/guides/public-pages.md.
import { coreFileUrl } from "@/lib/utils/core-url";
import { AUDIENCES, DOORS } from "./audience";

export const INDEX_HREF = "/guides";

export function missingGuideHeading(slug: string): string {
  return slug
    ? `Forge publishes no guide called “${slug}”`
    : "Forge publishes no guide at that address";
}

export const MISSING_GUIDE_BODY = `The index lists every guide there is, and each one is also readable as markdown at ${coreFileUrl(
  "/api/guides",
)}/<slug>.md with no credential.`;

export const MISSING_GUIDE_LINK_TEXT = "All Forge guides";

/** A refusal of an address on the public documentation: what it says, twice. */
export interface Refusal {
  heading: string;
  body: string;
}

const PICK_FROM_INDEX = "The index lists every page behind each of its three doors.";

export function missingPage(slug: string): Refusal {
  return {
    heading: slug ? `Forge publishes no page called “${slug}”` : "The link you followed names no page",
    body: PICK_FROM_INDEX,
  };
}

export function missingDoor(value: string): Refusal {
  return {
    heading: value ? `The documentation has no door called “${value}”` : "The link you followed names no door",
    body: `A door is one of ${AUDIENCES.map((a) => `“${a}” (${DOORS[a].label})`).join(", ")}.`,
  };
}

export const PAGE_AND_DOOR: Refusal = {
  heading: "An address names a page or a door, not both",
  body: `Open the page on its own, or the door on its own. ${PICK_FROM_INDEX}`,
};
