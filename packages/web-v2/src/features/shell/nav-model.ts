import type { BottomTabItem, NavItem } from "@/design";
import { joinedEcosystems, needsMe } from "@/features/ecosystem/inbox";
import { ecosystemRoutes } from "@/features/ecosystem/routes";
import type { WorkspaceRead } from "@/features/ecosystem/types";
import { needsYouHint } from "@/features/needs-you/hint";
import { NEEDS_YOU_AREA_LABELS, type NeedsYouAreaKey, type NeedsYouResponse } from "@/features/needs-you/types";
import type { RailEntry, RailItem } from "./nav-rail-compact";

export const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  // Overview = the all-projects home; the Attention queue is folded in here
  // (its live count rides on this row's badge).
  { key: "overview", label: "Overview", icon: "grid", href: "/" },
  { key: "runners", label: "Runners", icon: "server", href: "/runners" },
  // ISS-628 — workspace resource management, first type = Private Keys.
  { key: "resources", label: "Resources", icon: "lock", href: "/resources" },
  { key: "integrations", label: "Integrations", icon: "link", href: "/integrations" },
];

/** Destinations dropped from the rail to keep it minimal — still reachable via
 *  ⌘K. Settings also lives in the rail's account menu; Attention is folded into
 *  Overview. They are NOT rendered as rail rows. */
export const SECONDARY_DESTINATIONS: Array<NavItem & { href: string }> = [
  { key: "attention", label: "Attention", icon: "inbox", href: "/attention" },
  { key: "usage", label: "Usage", icon: "dollar", href: "/usage" },
  { key: "settings", label: "Settings", icon: "settings", href: "/settings" },
  { key: "pipeline-ops", label: "Pipeline ops", icon: "pipeline", href: "/ops" },
];

/** A project-tier nav item. `sub` is appended to `/projects/[slug]`. The rail
 *  renders these inline (Concept C) and ⌘K mirrors them for deep-nav. */
export interface ProjItem extends NavItem {
  sub: string;
}

export interface ProjGroup {
  key: string;
  label: string;
  icon: NavItem["icon"];
  items: ProjItem[];
}

export type ProjEntry = ProjItem | ProjGroup;

export const isProjGroup = (e: ProjEntry): e is ProjGroup => "items" in e;

export const DEVELOPMENT_GROUP_KEY = "development";

// cm:why the owner's IA ruling (ISS-65, FB-6): what a project is for comes first, and the
// machinery that builds it sits under one Development group.
export const PROJECT_MENU: ProjEntry[] = [
  { key: "proj-overview", label: "Dashboard", icon: "grid", sub: "" },
  { key: "proj-requirements", label: "Requirements", icon: "book", sub: "/requirements" },
  { key: "proj-workflows", label: "Workflows", icon: "flow", sub: "/workflows" },
  { key: "proj-releases", label: "Releases", icon: "rocket", sub: "/releases" },
  { key: "proj-feedback", label: "Feedback", icon: "chat", sub: "/feedback" },
  {
    key: DEVELOPMENT_GROUP_KEY,
    label: "Development",
    icon: "code",
    items: [
      { key: "proj-dev-overview", label: "Overview", icon: "activity", sub: "/overview" },
      { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
      { key: "proj-modules", label: "Modules", icon: "rows", sub: "/modules" },
      { key: "proj-agents", label: "Agents", icon: "agent", sub: "/agents" },
      { key: "proj-contracts", label: "Contracts", icon: "link", sub: "/contracts" },
      { key: "proj-automation", label: "Automation", icon: "calendar", sub: "/automation" },
    ],
  },
];

export const PROJECT_ITEMS: ProjItem[] = PROJECT_MENU.flatMap((e) => (isProjGroup(e) ? e.items : [e]));

// cm:why the waiting-on-you counts come from core's one needs-you read, each the size of its list's
// own waiting-on-you group, so a menu number never disagrees with the list it opens (REQ-11 BC-10)
export interface ProjectBadges {
  needsYou?: NeedsYouResponse | undefined;
  /** Workflow designs awaiting their approver. */
  designsAwaiting?: number | undefined;
}

const AREA_OF: Record<string, NeedsYouAreaKey> = {
  "proj-requirements": "requirements",
  "proj-releases": "releases",
  "proj-feedback": "feedback",
  "proj-issues": "issues",
  "proj-contracts": "contracts",
};

function badgeOf(key: string, badges: ProjectBadges): Pick<NavItem, "badge" | "badgeHint"> {
  const area = AREA_OF[key];
  if (area) {
    const read = badges.needsYou?.areas[area];
    return read ? { badge: read.you, badgeHint: needsYouHint(NEEDS_YOU_AREA_LABELS[area], read) } : {};
  }
  if (key === "proj-workflows" && badges.designsAwaiting !== undefined) {
    return { badge: badges.designsAwaiting, badgeHint: `Workflows · designs awaiting approval ${badges.designsAwaiting}` };
  }
  return {};
}

export function projectMenu(badges: ProjectBadges): ProjEntry[] {
  const withBadge = (it: ProjItem): ProjItem => ({ ...it, ...badgeOf(it.key, badges) });
  return PROJECT_MENU.map((e) => (isProjGroup(e) ? { ...e, items: e.items.map(withBadge) } : withBadge(e)));
}

export const ECO_THREADS_KEY = "eco-threads";
export const ECO_NEW_KEY = "eco-new";
const ECO_PREFIX = "eco:";

// cm:why the Ecosystem group is the workspace's: Threads, one row per ecosystem the person belongs to, and New ecosystem — nothing project-scoped, so it shows whichever project is open
export function ecosystemMenu(read: WorkspaceRead | undefined): NavItem[] {
  return [
    { key: ECO_THREADS_KEY, label: "Threads", icon: "mail", badge: read ? needsMe(read) : undefined },
    ...(read ? joinedEcosystems(read) : []).map((e) => ({
      key: `${ECO_PREFIX}${e.id}`,
      label: e.name,
      icon: "ecosystem" as const,
      mark: e.code,
      badge: needsMe(read as WorkspaceRead, e.id),
    })),
    { key: ECO_NEW_KEY, label: "New ecosystem", icon: "plus" },
  ];
}

/** Where an Ecosystem-group key leads, or null when the key is not one of the group's. */
export function ecosystemHref(key: string): string | null {
  if (key === ECO_THREADS_KEY) return ecosystemRoutes.threads();
  if (key === ECO_NEW_KEY) return ecosystemRoutes.create();
  return key.startsWith(ECO_PREFIX) ? ecosystemRoutes.ecosystem(key.slice(ECO_PREFIX.length)) : null;
}

function ecosystemKey(pathname: string): string | null {
  if (pathname === "/ecosystems/threads" || pathname.startsWith("/ecosystems/threads/")) return ECO_THREADS_KEY;
  if (pathname === "/ecosystems/new") return ECO_NEW_KEY;
  const m = pathname.match(/^\/ecosystems\/([^/]+)/);
  return m ? `${ECO_PREFIX}${decodeURIComponent(m[1])}` : null;
}

/** Parse the active project slug out of the (basePath-stripped) pathname. */
export function activeSlug(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m ? m[1] : null;
}

export function resolveRailSlug(opts: {
  slug: string | null;
  lastSlug: string | null;
  stickySlug: string | null;
  scopedProjects: Array<{ id: string; slug: string }>;
  pinnedIds: ReadonlySet<string>;
}): string | null {
  const { slug, lastSlug, stickySlug, scopedProjects: list, pinnedIds } = opts;
  if (slug) return slug;
  const inScope = (s: string | null) => !!s && list.some((p) => p.slug === s);
  if (inScope(lastSlug)) return lastSlug;
  if (inScope(stickySlug)) return stickySlug;
  const pinnedFirst = list.find((p) => pinnedIds.has(p.id));
  return pinnedFirst?.slug ?? list[0]?.slug ?? null;
}

/** Project items by descending sub-length so the longest match wins (e.g.
 *  "/issues" beats "" for Overview). Sorted once — the list is a module const. */
export const PROJECT_ITEMS_BY_SPECIFICITY = [...PROJECT_ITEMS].sort(
  (a, b) => b.sub.length - a.sub.length,
);

/** Match a project-relative path remainder against a project-tier `sub`
 *  (mirrors the project tab bar's logic so the rail lights the right row). */
export function matchesSub(rest: string, sub: string): boolean {
  return sub === "" ? rest === "" : rest === sub || rest.startsWith(`${sub}/`);
}

/** Active rail row for a pathname. Inside a project the rail carries the
 *  project tier, so we light the matching `proj-*` key by matching the
 *  project-relative remainder (mirrors the old tab bar's matchesSub). Docs is
 *  lit on its own route. */
export function buildActiveKey(pathname: string, slug: string | null): string {
  if (pathname.startsWith("/whats-new")) return "whats-new";
  if (pathname.startsWith("/docs")) return "docs";
  const eco = ecosystemKey(pathname);
  if (eco) return eco;
  if (slug) {
    const base = `/projects/${slug}`;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
    const hit = PROJECT_ITEMS_BY_SPECIFICITY.find((it) => matchesSub(rest, it.sub));
    return hit?.key ?? "proj-overview";
  }
  const ws = WORKSPACE_ITEMS.find((it) =>
    it.href === "/" ? pathname === "/" : pathname.startsWith(it.href),
  );
  return ws?.key ?? "overview";
}

// cm:why More and Chat are lit by state because each opens a sheet over the page and is no route of its own; the other tabs follow the route
export function buildBottomActiveKey(pathname: string, moreOpen: boolean, chatOpen: boolean): string {
  if (moreOpen) return "more";
  if (chatOpen) return "chat";
  if (pathname.startsWith("/attention")) return "attention";
  return "home";
}

export function workspaceNavItems(attentionCount: number): NavItem[] {
  return WORKSPACE_ITEMS.map((it) =>
    it.key === "overview" ? { ...it, badge: attentionCount } : it,
  );
}

export function compactWorkspaceRailItems(attentionCount: number): RailItem[] {
  return WORKSPACE_ITEMS.map((it) => ({
    key: it.key,
    label: it.label,
    icon: it.icon,
    ...(it.key === "overview" ? { badge: attentionCount } : {}),
  }));
}

/** The compact rail's project tier: the same menu, Development folded under its head. */
export function projectRailItems(badges: ProjectBadges): RailEntry[] {
  const row = (it: ProjItem): RailItem => ({ key: it.key, label: it.label, icon: it.icon, ...badgeOf(it.key, badges) });
  return PROJECT_MENU.map((e) => (isProjGroup(e) ? { key: e.key, label: e.label, icon: e.icon, items: e.items.map(row) } : row(e)));
}

export function bottomTabItems(attentionCount: number): BottomTabItem[] {
  return [
    { key: "home", label: "Home", icon: "grid" },
    { key: "chat", label: "Ask Agent", icon: "chat" },
    { key: "attention", label: "Attention", icon: "inbox", badge: attentionCount },
    { key: "more", label: "More", icon: "menu" },
  ];
}
