import { PRODUCT_TOURS, TOUR_STEPS_MAX, type TourId } from "@forge/contracts/tours";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { releaseHref } from "@/lib/routes/releases";

/** The project roles, weakest first: a tour is offered to its audience's role and every stronger one. */
const ROLES = ["viewer", "member", "admin", "owner"] as const;
type TourAudience = (typeof ROLES)[number];

export interface TourStep {
  /** The stable `data-tour` attribute the step points at, never a CSS class. */
  anchor: string;
  title: ProductCopyKey;
  body: ProductCopyKey;
}

/** Where a tour runs: the pages it matches, and the address of one for a project. */
interface TourRoute {
  pattern: RegExp;
  /** The `?tab=` the page must hold, where the route is one tab of a screen. */
  tab?: string;
  href: (slug: string, at?: { version?: string }) => string | null;
}

export interface TourDefinition {
  id: TourId;
  revision: number;
  audience: TourAudience;
  route: TourRoute;
  title: ProductCopyKey;
  hint: { new: ProductCopyKey; updated: ProductCopyKey };
  steps: TourStep[];
}

type TourParts = Omit<TourDefinition, "id" | "revision">;

// what each catalog tour does on the page; the id and revision are the catalog's (`@forge/contracts/tours`)
const PARTS: Record<TourId, TourParts> = {
  "release-what-changes": {
    audience: "viewer",
    route: {
      pattern: /^\/projects\/[^/]+\/releases\/[^/]+$/,
      href: (slug, at) => (at?.version ? releaseHref(slug, at.version) : null),
    },
    title: "tour.release-what-changes.title",
    hint: { new: "tour.release-what-changes.hint.new", updated: "tour.release-what-changes.hint.updated" },
    steps: [
      { anchor: "rel-users", title: "tour.release-what-changes.step1.title", body: "tour.release-what-changes.step1.body" },
      { anchor: "rel-technical", title: "tour.release-what-changes.step2.title", body: "tour.release-what-changes.step2.body" },
    ],
  },
  integrations: {
    audience: "admin",
    route: {
      pattern: /^\/projects\/[^/]+\/settings$/,
      tab: "connections",
      href: (slug) => `/projects/${encodeURIComponent(slug)}/settings?tab=connections`,
    },
    title: "tour.integrations.title",
    hint: { new: "tour.integrations.hint.new", updated: "tour.integrations.hint.updated" },
    steps: [
      { anchor: "int-status", title: "tour.integrations.step1.title", body: "tour.integrations.step1.body" },
      { anchor: "int-connect", title: "tour.integrations.step2.title", body: "tour.integrations.step2.body" },
      { anchor: "int-share", title: "tour.integrations.step3.title", body: "tour.integrations.step3.body" },
    ],
  },
};

export const TOURS: readonly TourDefinition[] = PRODUCT_TOURS.map((t) => {
  const parts = PARTS[t.id];
  if (parts.steps.length > TOUR_STEPS_MAX) {
    throw new Error(`tour ${t.id} has ${parts.steps.length} steps; a tour is at most ${TOUR_STEPS_MAX}`);
  }
  return { id: t.id, revision: t.revision, ...parts };
});

export function tourById(id: string | null | undefined): TourDefinition | null {
  return TOURS.find((t) => t.id === id) ?? null;
}

/** Whether a person of `role` on the project is a tour's audience. */
export function inAudience(tour: TourDefinition, role: string | null | undefined): boolean {
  const held = ROLES.indexOf((role ?? "") as TourAudience);
  return held >= 0 && held >= ROLES.indexOf(tour.audience);
}

/** Whether the page at `pathname` with `search` is one the tour runs on. */
export function onTourRoute(tour: TourDefinition, pathname: string, search: URLSearchParams): boolean {
  if (!tour.route.pattern.test(pathname)) return false;
  return tour.route.tab === undefined || search.get("tab") === tour.route.tab;
}
