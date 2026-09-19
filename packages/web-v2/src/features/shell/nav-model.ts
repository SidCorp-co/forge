import type { BottomTabItem, Crumb, NavItem } from "@/design";
import type { RailItem } from "./nav-rail-compact";

export const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  // Overview = the all-projects home; the Attention queue is folded in here
  // (its live count rides on this row's badge).
  { key: "overview", label: "Overview", icon: "grid", href: "/" },
  // ISS-668 — replaces the ISS-667 "Sessions" entry (mixed chat+pipeline) with
  // a chat-only cross-project surface. Pipeline job sessions stay reachable via
  // the project-tier Agents view + Ops monitor (see conversations-screen.tsx).
  { key: "conversations", label: "Conversations", icon: "agent", href: "/conversations" },
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

export const PROJECT_ITEMS: ProjItem[] = [
  { key: "proj-overview", label: "Dashboard", icon: "grid", sub: "" },
  { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
  { key: "proj-agents", label: "Agents", icon: "agent", sub: "/agents" },
  { key: "proj-library", label: "Library", icon: "book", sub: "/library" },
  { key: "proj-automation", label: "Automation", icon: "calendar", sub: "/automation" },
];

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

export function buildBottomActiveKey(pathname: string, slug: string | null): string {
  if (slug) {
    const base = `/projects/${slug}`;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
    const hit = PROJECT_ITEMS_BY_SPECIFICITY.find((it) => matchesSub(rest, it.sub));
    return hit?.key ?? "proj-overview";
  }
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/attention")) return "attention";
  if (pathname.startsWith("/settings")) return "you";
  return "";
}

export function workspaceNavItems(attentionCount: number): NavItem[] {
  return WORKSPACE_ITEMS.map((it) =>
    it.key === "overview" ? { ...it, badge: attentionCount } : it,
  );
}

/** Compact-rail workspace rows. Derived from WORKSPACE_ITEMS so the compact
 *  and expanded rails can never drift (ISS-433 live-E2E caught this list as a
 *  stale hardcoded duplicate — it was missing the promoted Integrations row). */
export function compactWorkspaceRailItems(attentionCount: number): RailItem[] {
  return WORKSPACE_ITEMS.map((it) => ({
    key: it.key,
    label: it.label,
    icon: it.icon,
    ...(it.key === "overview" ? { badge: attentionCount } : {}),
  }));
}

/** Project tier with the Issues queue badge (= open issues). Agents would carry
 *  an active-sessions count, but the console rollup has no per-project session
 *  total yet, so it stays unbadged until that field ships. */
export function projectRailItems(openIssues: number | undefined): RailItem[] {
  return PROJECT_ITEMS.map((it) => ({
    key: it.key,
    label: it.label,
    icon: it.icon,
    badge: it.key === "proj-issues" ? openIssues : undefined,
  }));
}

export function bottomTabItems(
  slug: string | null,
  attentionCount: number,
  openIssues: number | undefined,
): BottomTabItem[] {
  if (slug) {
    return [
      { key: "proj-overview", label: "Dashboard", icon: "grid" },
      { key: "proj-issues", label: "Issues", icon: "list", badge: openIssues },
      { key: "chat", label: "Chat", icon: "chat" },
      { key: "proj-agents", label: "Agents", icon: "agent" },
      { key: "switcher", label: "Project", icon: "folder" },
    ];
  }
  return [
    { key: "projects", label: "Projects", icon: "folder" },
    { key: "attention", label: "Attention", icon: "inbox", badge: attentionCount },
    { key: "search", label: "Search", icon: "search" },
    { key: "you", label: "You", icon: "settings" },
  ];
}

export function buildCrumbs(opts: {
  pathname: string;
  slug: string | null;
  activeKey: string;
  projectName: string | null | undefined;
}): Crumb[] {
  const { pathname, slug, activeKey, projectName } = opts;
  const wsRoot: Crumb = { label: "Workspace", href: "/" };
  if (pathname === "/") return [wsRoot, { label: "Overview" }];

  if (slug) {
    const page = PROJECT_ITEMS.find((it) => it.key === activeKey);
    return [
      { label: "Projects", href: "/projects" },
      { label: projectName ?? slug, href: `/projects/${slug}` },
      { label: page?.label ?? "Dashboard" },
    ];
  }

  if (pathname.startsWith("/whats-new")) return [wsRoot, { label: "What's New" }];
  if (pathname.startsWith("/docs")) return [wsRoot, { label: "Docs" }];
  // Resolve the page label from the rail destinations; longest href match wins.
  const hit = [...WORKSPACE_ITEMS, ...SECONDARY_DESTINATIONS]
    .filter((it) => it.href !== "/" && pathname.startsWith(it.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return hit ? [wsRoot, { label: hit.label }] : [wsRoot, { label: "Overview" }];
}
