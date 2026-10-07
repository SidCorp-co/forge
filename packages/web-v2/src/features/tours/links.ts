import type { TourDefinition } from "./registry";

/** The address that opens `tour` on a page of the project `slug`: its route, with `?tour=` set. */
export function tourHref(tour: TourDefinition, slug: string | null | undefined, at?: { version?: string }): string | null {
  if (!slug) return null;
  const base = tour.route.href(slug, at);
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}tour=${encodeURIComponent(tour.id)}`;
}
