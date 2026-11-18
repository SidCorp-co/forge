// Where a box opens (ISS-1325): its screen alone, for a person who wants to watch or drive it (a link
// from an issue, a release or a posted message, and a phone); or the Boxes page with it selected,
// beside the others, its feed and its criteria.

/** The `?box=` param the Boxes page selects by. */
export const BOX_PARAM = "box";

/** The box's screen alone, full viewport: `/projects/<slug>/boxes/<box id>`. */
export const boxScreenHref = (slug: string, boxId: string) => `/projects/${slug}/boxes/${encodeURIComponent(boxId)}`;

/** The Boxes page with the box selected (`?box=`). */
export const boxesPageHref = (slug: string, boxId: string) => `/projects/${slug}/boxes?${BOX_PARAM}=${encodeURIComponent(boxId)}`;
