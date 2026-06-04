"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  NavRail,
  BottomTabBar,
  type BottomTabItem,
  TopBar,
  CommandPalette,
  NotificationsMenu,
  PinnedTabBar,
  ProjectMark,
  Icon,
  type NavItem,
  type Command,
  type Crumb,
} from "@/design";
import { cn } from "@/lib/utils/cn";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects, useProjectsConsole } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { ProjectFlyout } from "@/features/projects/components/project-flyout";
import { useAttention } from "@/features/attention/hooks";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import {
  useSidebar,
  useRecents,
  usePinnedViews,
  NavRailCompact,
  type RailItem,
  type SwitcherProject,
} from "@/features/shell";

/** Concept C (ISS-307): the left rail is two-tier — workspace destinations on
 *  top, then (when a project is active) an inline project tier with a searchable
 *  switcher flyout. Keys are globally unique (project-tier keys are prefixed
 *  `proj-`) so a single `activeKey` never lights two rows. */
const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  // Overview = the all-projects home; the Attention queue is folded in here
  // (its live count rides on this row's badge).
  { key: "overview", label: "Overview", icon: "grid", href: "/" },
  { key: "usage", label: "Usage", icon: "dollar", href: "/usage" },
  { key: "runners", label: "Runners", icon: "server", href: "/runners" },
];

/** Destinations dropped from the rail to keep it minimal — still reachable via
 *  ⌘K. Settings also lives in the rail's account menu; Attention is folded into
 *  Overview. They are NOT rendered as rail rows. */
const SECONDARY_DESTINATIONS: Array<NavItem & { href: string }> = [
  { key: "attention", label: "Attention", icon: "inbox", href: "/attention" },
  { key: "settings", label: "Settings", icon: "settings", href: "/settings" },
  { key: "integrations", label: "Integrations", icon: "link", href: "/integrations" },
  { key: "sessions", label: "Sessions", icon: "agent", href: "/sessions" },
  { key: "pipeline-ops", label: "Pipeline ops", icon: "pipeline", href: "/ops" },
];

/** A project-tier nav item. `sub` is appended to `/projects/[slug]`. The rail
 *  renders these inline (Concept C) and ⌘K mirrors them for deep-nav. */
interface ProjItem extends NavItem {
  sub: string;
}

/** Concept C: exactly 5 flat project-tier items (no clusters), matching the
 *  draft (ISS-360): Dashboard, Issues, Agents, Library, Automation. The
 *  standalone Pipeline entry was dropped — the pipeline kanban folds into the
 *  Issues views, and `/pipeline` stays reachable via issue-detail + ⌘K. Agents
 *  merges Sessions+Chat; Library merges Knowledge+Memory+Skills; Automation
 *  merges Schedules+PM. */
const PROJECT_ITEMS: ProjItem[] = [
  { key: "proj-overview", label: "Dashboard", icon: "grid", sub: "" },
  { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
  { key: "proj-agents", label: "Agents", icon: "agent", sub: "/agents" },
  { key: "proj-library", label: "Library", icon: "book", sub: "/library" },
  { key: "proj-automation", label: "Automation", icon: "calendar", sub: "/automation" },
];

/** Parse the active project slug out of the (basePath-stripped) pathname. */
function activeSlug(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m ? m[1] : null;
}

/** Project items by descending sub-length so the longest match wins (e.g.
 *  "/issues" beats "" for Overview). Sorted once — the list is a module const. */
const PROJECT_ITEMS_BY_SPECIFICITY = [...PROJECT_ITEMS].sort((a, b) => b.sub.length - a.sub.length);

/** Match a project-relative path remainder against a project-tier `sub`
 *  (mirrors the project tab bar's logic so the rail lights the right row). */
function matchesSub(rest: string, sub: string): boolean {
  return sub === "" ? rest === "" : rest === sub || rest.startsWith(`${sub}/`);
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { user, isLoading, logout } = useAuth();
  const { toast } = useToast();
  const { data: projects } = useProjects();
  const sidebar = useSidebar();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { pinnedIds } = usePinnedProjects();
  // Rail + bottom-bar Attention badge. `total` already folds in offline runners.
  const { total: attentionCount } = useAttention();
  // What's New nav badge — shown when the newest changelog entry is unseen.
  const { hasUnseen: whatsNewUnseen } = useWhatsNewStatus();

  // Auth gate: once /auth/me has resolved, an unauthenticated visitor is sent
  // to /login (which also makes logout() "return here" effective). While the
  // session is still hydrating we render the shell rather than flash a redirect.
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // Hover-open coordination for the expanded-rail project switcher: the trigger
  // (NavRail) and the panel (ProjectFlyout) are siblings, so the open + close
  // timer is lifted here. Mirrors the compact rail's 150ms close delay so the
  // pointer can travel from the switcher to the panel without it closing.
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFlyout = useCallback(() => {
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
    setFlyoutOpen(true);
  }, []);
  const scheduleCloseFlyout = useCallback(() => {
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
    flyoutCloseTimer.current = setTimeout(() => setFlyoutOpen(false), 150);
  }, []);

  // Close the mobile drawer + project flyout whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
    setFlyoutOpen(false);
  }, [pathname]);

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  const slug = activeSlug(pathname);
  const activeProject = useMemo(
    () => (slug ? projects?.find((p) => p.slug === slug) ?? null : null),
    [projects, slug],
  );

  // Remember the last project visited so the rail can keep showing a project
  // context (mark + tier) even on workspace screens — no vanishing block.
  const [lastSlug, setLastSlug] = usePersistedState<string | null>("web-v2:last-project", null);
  useEffect(() => {
    if (slug && slug !== lastSlug) setLastSlug(slug);
  }, [slug, lastSlug, setLastSlug]);

  // The project the rail renders: the one you're in, else the last visited, else
  // your first (pinned-first) project. Lets you re-enter a project from anywhere.
  const railSlug = useMemo(() => {
    if (slug) return slug;
    const list = projects ?? [];
    if (lastSlug && list.some((p) => p.slug === lastSlug)) return lastSlug;
    const pinnedFirst = list.find((p) => pinnedIds.has(p.id));
    return pinnedFirst?.slug ?? list[0]?.slug ?? null;
  }, [slug, lastSlug, projects, pinnedIds]);
  const railProject = useMemo(
    () => (railSlug ? projects?.find((p) => p.slug === railSlug) ?? null : null),
    [projects, railSlug],
  );

  // ⌘K / Ctrl-K toggles the command palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Active rail row. Inside a project the rail carries the project tier, so we
  // light the matching `proj-*` key by matching the project-relative remainder
  // (mirrors the old tab bar's matchesSub). Docs is lit on its own route.
  const activeKey = useMemo(() => {
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
  }, [pathname, slug]);

  // Breadcrumb trail for the top header (ISS-358; ISS-359 fix). The root crumb
  // is derived from context instead of hard-pinning "Overview" in front of every
  // screen:
  //   • landing `/`            → "Workspace / Overview" (you're on Overview)
  //   • project-tier screens   → "Projects / <Project> / <Page>"
  //   • other workspace screens→ "Workspace / <Page>"
  const crumbs = useMemo<Crumb[]>(() => {
    const wsRoot: Crumb = { label: "Workspace", href: "/" };
    if (pathname === "/") return [wsRoot, { label: "Overview" }];

    if (slug) {
      const page = PROJECT_ITEMS.find((it) => it.key === activeKey);
      return [
        { label: "Projects", href: "/projects" },
        { label: activeProject?.name ?? slug, href: `/projects/${slug}` },
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
  }, [pathname, slug, activeProject, activeKey]);

  // Project-tier glyph for the rail's switcher button — follows the rail project.
  const projectMark = useMemo(() => {
    if (!railProject) return undefined;
    const g = projectGlyph(railProject.id);
    return {
      name: railProject.name,
      initials: projectInitials(railProject.name),
      tint: g.tint,
      ink: g.ink,
    };
  }, [railProject]);

  // Attention is folded into Overview — its live count rides Overview's badge.
  const railItems = useMemo<NavItem[]>(
    () =>
      WORKSPACE_ITEMS.map((it) =>
        it.key === "overview" ? { ...it, badge: attentionCount } : it,
      ),
    [attentionCount],
  );

  // Compact-rail data: the console rollup gives per-project liveRuns/openIssues
  // (for the "{N} live" label, the switcher pulse dots, and the Issues badge).
  const projectsConsole = useProjectsConsole();
  const switcherProjects = useMemo<SwitcherProject[]>(
    () =>
      projectsConsole.items.map((p) => {
        const g = projectGlyph(p.id);
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          initials: projectInitials(p.name),
          tint: g.tint,
          ink: g.ink,
          liveRuns: p.liveRuns,
          pinned: p.pinned,
        };
      }),
    [projectsConsole.items],
  );
  const railConsole = useMemo(
    () => (railSlug ? projectsConsole.items.find((p) => p.slug === railSlug) ?? null : null),
    [projectsConsole.items, railSlug],
  );
  const compactActiveProject = useMemo(
    () =>
      railProject && projectMark
        ? {
            name: projectMark.name,
            initials: projectMark.initials,
            tint: projectMark.tint,
            ink: projectMark.ink,
            liveRuns: railConsole?.liveRuns ?? 0,
          }
        : null,
    [railProject, projectMark, railConsole],
  );
  const compactWorkspaceItems = useMemo<RailItem[]>(
    () => [
      { key: "overview", label: "Overview", icon: "grid", badge: attentionCount },
      { key: "usage", label: "Usage", icon: "dollar" },
      { key: "runners", label: "Runners", icon: "server" },
    ],
    [attentionCount],
  );
  // Project tier with the Issues queue badge (= open issues). Agents would carry
  // an active-sessions count, but the console rollup has no per-project session
  // total yet, so it stays unbadged until that field ships.
  const compactProjectItems = useMemo<RailItem[] | null>(
    () =>
      compactActiveProject
        ? PROJECT_ITEMS.map((it) => ({
            key: it.key,
            label: it.label,
            icon: it.icon,
            badge: it.key === "proj-issues" ? railConsole?.openIssues : undefined,
          }))
        : null,
    [compactActiveProject, railConsole],
  );

  function navigate(key: string) {
    if (key === "whats-new") {
      router.push("/whats-new");
      return;
    }
    if (key === "docs") {
      router.push("/docs");
      return;
    }
    if (key.startsWith("proj-") && railSlug) {
      const item = PROJECT_ITEMS.find((it) => it.key === key);
      if (item) router.push(`/projects/${railSlug}${item.sub}`);
      return;
    }
    const dest =
      WORKSPACE_ITEMS.find((it) => it.key === key) ??
      SECONDARY_DESTINATIONS.find((it) => it.key === key);
    if (dest) router.push(dest.href);
  }

  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : undefined;

  // Bottom tab bar (<md): ≤5 destinations. Search opens ⌘K; You → account.
  const bottomItems: BottomTabItem[] = useMemo(
    () => [
      { key: "projects", label: "Projects", icon: "folder" },
      { key: "attention", label: "Attention", icon: "inbox", badge: attentionCount },
      { key: "usage", label: "Usage", icon: "dollar" },
      { key: "search", label: "Search", icon: "search" },
      { key: "you", label: "You", icon: "settings" },
    ],
    [attentionCount],
  );

  const bottomActiveKey = useMemo(() => {
    // "Projects" tab → the list at /projects (incl. project detail). The
    // Overview dashboard at `/` is reachable via the rail/⌘K, not a bottom tab.
    if (pathname.startsWith("/projects")) return "projects";
    if (pathname.startsWith("/attention")) return "attention";
    if (pathname.startsWith("/usage")) return "usage";
    if (pathname.startsWith("/settings")) return "you";
    return "";
  }, [pathname]);

  function onBottomSelect(key: string) {
    switch (key) {
      case "projects":
        router.push("/projects");
        break;
      case "attention":
        router.push("/attention");
        break;
      case "usage":
        router.push("/usage");
        break;
      case "search":
        setPaletteOpen(true);
        break;
      case "you":
        router.push("/settings");
        break;
    }
  }

  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];

    // Recent — recently-viewed entities.
    for (const r of recents) {
      out.push({
        label: r.label,
        icon: r.icon ?? "clock",
        group: "recent",
        keywords: r.kind,
        onRun: () => router.push(r.href),
      });
    }

    // Pinned — pinned projects + pinned views.
    for (const p of projects ?? []) {
      if (!pinnedIds.has(p.id)) continue;
      out.push({
        label: p.name,
        icon: "pin",
        group: "pinned",
        keywords: "project",
        onRun: () => router.push(`/projects/${p.slug}`),
      });
    }
    for (const v of pinnedViews.views) {
      out.push({
        label: v.label,
        icon: v.icon,
        group: "pinned",
        keywords: "view",
        onRun: () => router.push(v.href),
      });
    }

    // Navigate — workspace rail items + the secondary destinations dropped from
    // the rail (so deep nav stays reachable) + project switcher + project sub-nav.
    for (const it of WORKSPACE_ITEMS) {
      out.push({ label: it.label, icon: it.icon, group: "navigate", onRun: () => router.push(it.href) });
    }
    for (const it of SECONDARY_DESTINATIONS) {
      out.push({ label: it.label, icon: it.icon, group: "navigate", keywords: "go to", onRun: () => router.push(it.href) });
    }
    out.push({
      label: "What's New",
      icon: "bell",
      group: "navigate",
      keywords: "changelog release notes updates go to",
      onRun: () => router.push("/whats-new"),
    });
    out.push({
      label: "Docs",
      icon: "book",
      group: "navigate",
      keywords: "help documentation guides go to",
      onRun: () => router.push("/docs"),
    });
    // The project list moved off the landing route to /projects (ISS-355) — keep
    // it reachable from ⌘K (the rail flyout/mobile drawer cover the pointer path).
    out.push({
      label: "All projects",
      icon: "folder",
      group: "navigate",
      keywords: "projects list console go to",
      onRun: () => router.push("/projects"),
    });
    for (const p of projects ?? []) {
      out.push({
        label: `Switch to ${p.name}`,
        icon: "folder",
        group: "navigate",
        keywords: "project switch",
        onRun: () => router.push(`/projects/${p.slug}`),
      });
    }
    if (slug) {
      for (const it of PROJECT_ITEMS) {
        out.push({
          label: `${activeProject?.name ?? slug} · ${it.label}`,
          icon: it.icon,
          group: "navigate",
          onRun: () => router.push(`/projects/${slug}${it.sub}`),
        });
      }
      // Project settings (ISS-316) — a nested route kept off the rail, reachable
      // via the dashboard gear and here.
      out.push({
        label: `${activeProject?.name ?? slug} · Settings`,
        icon: "settings",
        group: "navigate",
        keywords: "project settings config repo branch members labels pipeline",
        onRun: () => router.push(`/projects/${slug}/settings`),
      });
    }

    // Actions — wired to existing handlers/routes only; no fabricated endpoints.
    out.push({
      label: "Create issue",
      icon: "plus",
      group: "actions",
      keywords: "new issue",
      onRun: () =>
        slug
          ? router.push(`/projects/${slug}/issues?new=1`)
          : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" }),
    });
    out.push({
      label: "Dispatch pipeline",
      icon: "pipeline",
      group: "actions",
      keywords: "run dispatch",
      onRun: () => (slug ? router.push(`/projects/${slug}/pipeline`) : router.push("/ops")),
    });
    out.push({
      label: "Pair device",
      icon: "server",
      group: "actions",
      keywords: "runner device",
      onRun: () => router.push("/runners"),
    });
    out.push({
      label: "Cancel a run",
      icon: "stop",
      group: "actions",
      keywords: "cancel run abort",
      onRun: () => (slug ? router.push(`/projects/${slug}/pipeline`) : router.push("/ops")),
    });

    return out;
  }, [router, slug, activeProject, projects, recents, pinnedViews.views, pinnedIds, toast]);

  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      {/* Desktop rail — compact 76px icon Rail by default (Concept C); expands
          to the labeled 232px NavRail. Hidden below md (bottom tab bar takes
          over). */}
      <div className="hidden h-full md:block">
        {sidebar.collapsed ? (
          <NavRailCompact
            workspaceItems={compactWorkspaceItems}
            projectItems={compactProjectItems}
            activeKey={activeKey}
            activeSlug={railSlug}
            activeProject={compactActiveProject}
            switcherProjects={switcherProjects}
            onNavigate={navigate}
            onSelectProject={(s) => router.push(`/projects/${s}`)}
            onTogglePin={projectsConsole.toggle}
            onAllProjects={() => router.push("/projects")}
            onNewProject={() => router.push("/projects?new=1")}
            onAccount={() => router.push("/settings")}
            onSignOut={logout}
            userInitials={userInitials}
            onExpand={sidebar.toggleCollapsed}
            onWhatsNew={() => router.push("/whats-new")}
            whatsNewBadge={whatsNewUnseen ? 1 : 0}
            onDocs={() => router.push("/docs")}
          />
        ) : (
          <>
            <NavRail
              workspaceItems={railItems}
              project={projectMark}
              projectItems={projectMark ? PROJECT_ITEMS : undefined}
              onProjectSwitch={() => setFlyoutOpen((o) => !o)}
              onSwitcherEnter={openFlyout}
              onSwitcherLeave={scheduleCloseFlyout}
              activeKey={activeKey}
              onNavigate={navigate}
              onDocs={() => router.push("/docs")}
              onWhatsNew={() => router.push("/whats-new")}
              whatsNewBadge={whatsNewUnseen ? 1 : 0}
              onAccount={() => router.push("/settings")}
              onSignOut={logout}
              user={userInitials ? { initials: userInitials } : undefined}
              onToggleCollapsed={sidebar.toggleCollapsed}
            />
            {/* Searchable project switcher for the expanded rail. */}
            <ProjectFlyout
              open={flyoutOpen}
              onClose={() => setFlyoutOpen(false)}
              activeSlug={railSlug}
              onPanelEnter={openFlyout}
              onPanelLeave={scheduleCloseFlyout}
              onViewAll={() => router.push("/projects")}
              onCreateProject={() => router.push("/projects?new=1")}
            />
          </>
        )}
      </div>

      {/* Mobile drawer — a project switcher (the workspace destinations live in
          the bottom tab bar). Opened from the TopBar menu button, below md. */}
      {mobileNavOpen && (
        <div className="md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="fixed inset-0 z-40 cursor-default"
            style={{ background: "rgba(24,27,34,0.4)" }}
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            className="forge-slide fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[82vw] flex-col gap-1 border-r border-line bg-surface p-3 pb-[env(safe-area-inset-bottom)] pt-[max(env(safe-area-inset-top),0.75rem)]"
            role="dialog"
            aria-modal="true"
            aria-label="Switch project"
          >
            <div className="flex items-center justify-between px-1.5 pb-2">
              <span className="fg-label text-fg">Projects</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => router.push("/projects?new=1")}
                  className="fg-caption inline-flex items-center gap-1 rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  <Icon name="plus" size={13} />
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/projects")}
                  className="fg-caption rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  View all
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {(projects ?? []).map((p) => {
                const g = projectGlyph(p.id);
                const active = p.slug === slug;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => router.push(`/projects/${p.slug}`)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                      active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <ProjectMark tint={g.tint} ink={g.ink} initials={projectInitials(p.name)} size={24} radius="var(--r-sm)" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </button>
                );
              })}
              {(projects ?? []).length === 0 && (
                <p className="fg-body-sm px-1.5 py-2 text-muted">No projects yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative">
          <TopBar
            breadcrumb={crumbs}
            onBreadcrumbNavigate={(href) => router.push(href)}
            onMenu={() => setMobileNavOpen(true)}
            onCommandPalette={() => setPaletteOpen(true)}
            onNotifications={() => setNotificationsOpen((o) => !o)}
            onNewIssue={() =>
              slug
                ? router.push(`/projects/${slug}/issues?new=1`)
                : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" })
            }
            scrolled={scrolled}
          />
          {notificationsOpen && (
            <>
              {/* click-away catcher */}
              <button
                type="button"
                aria-label="Close notifications"
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setNotificationsOpen(false)}
              />
              <div className="absolute right-4 top-[52px] z-50">
                <NotificationsMenu items={[]} />
              </div>
            </>
          )}
        </div>

        <PinnedTabBar
          tabs={pinnedViews.views}
          activeHref={pathname}
          onSelect={(href) => router.push(href)}
          onRemove={pinnedViews.remove}
        />

        <main
          ref={mainRef}
          className="min-h-0 flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0"
          onScroll={(e) => {
            const top = (e.target as HTMLElement).scrollTop;
            setScrolled((s) => (s ? top > 4 : top > 8));
          }}
        >
          {children}
        </main>
      </div>

      <BottomTabBar items={bottomItems} activeKey={bottomActiveKey} onSelect={onBottomSelect} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
