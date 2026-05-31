"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  type NavItem,
  type Command,
} from "@/design";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { useAttention } from "@/features/attention/hooks";
import {
  DensityProvider,
  useDensity,
  useSidebar,
  useRecents,
  usePinnedViews,
} from "@/features/shell";

/** Concept B (ISS-307): the left rail carries ONLY workspace destinations.
 *  Project context moved to a horizontal tab bar (projects/[slug]/layout.tsx),
 *  and the secondary destinations below moved into ⌘K. Keys are globally unique
 *  (project-tier keys are prefixed `proj-`) so a single `activeKey` never lights
 *  two rows. */
const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  { key: "projects", label: "Projects", icon: "folder", href: "/" },
  { key: "attention", label: "Attention", icon: "inbox", href: "/attention" },
  { key: "activity", label: "Activity", icon: "activity", href: "/activity" },
  { key: "runners", label: "Runners", icon: "server", href: "/runners" },
  { key: "settings", label: "Settings", icon: "settings", href: "/settings" },
];

/** Destinations dropped from the rail to keep it minimal — still reachable via
 *  ⌘K (Step 5 of the plan). They are NOT rendered on the rail. */
const SECONDARY_DESTINATIONS: Array<NavItem & { href: string }> = [
  { key: "integrations", label: "Integrations", icon: "link", href: "/integrations" },
  { key: "sessions", label: "Sessions", icon: "agent", href: "/sessions" },
  { key: "pipeline-ops", label: "Pipeline ops", icon: "pipeline", href: "/ops" },
];

/** A project-tier nav item. `sub` is appended to `/projects/[slug]`; `href`
 *  routes to an absolute (workspace) target where no project-scoped route
 *  exists. Kept ONLY to feed ⌘K deep-nav — the rail no longer renders these. */
interface ProjItem extends NavItem {
  sub?: string;
  href?: string;
}

const PROJECT_ITEMS: ProjItem[] = [
  { key: "proj-overview", label: "Overview", icon: "grid", sub: "" },
  { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
  { key: "proj-pipeline", label: "Pipeline", icon: "pipeline", sub: "/pipeline" },
  { key: "proj-sessions", label: "Sessions", icon: "agent", sub: "/sessions" },
  { key: "proj-pm", label: "PM", icon: "shield", sub: "/pm" },
  { key: "proj-knowledge", label: "Knowledge", icon: "book", sub: "/knowledge" },
  { key: "proj-memory", label: "Memory", icon: "archive", sub: "/memory" },
  { key: "proj-schedules", label: "Schedules", icon: "calendar", sub: "/schedules" },
  { key: "proj-skills", label: "Skills", icon: "star", sub: "/skills" },
  { key: "proj-chat", label: "Chat", icon: "mail", sub: "/agent" },
];

/** Parse the active project slug out of the (basePath-stripped) pathname. */
function activeSlug(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m ? m[1] : null;
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <DensityProvider>
      <WorkspaceShell>{children}</WorkspaceShell>
    </DensityProvider>
  );
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { user, isLoading, logout } = useAuth();
  const { toast } = useToast();
  const { data: projects } = useProjects();
  const { density, setDensity } = useDensity();
  const sidebar = useSidebar();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { pinnedIds } = usePinnedProjects();
  // Rail + bottom-bar Attention badge. `total` already folds in offline runners.
  const { total: attentionCount } = useAttention();

  // Auth gate: once /auth/me has resolved, an unauthenticated visitor is sent
  // to /login (which also makes logout() "return here" effective). While the
  // session is still hydrating we render the shell rather than flash a redirect.
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Close the mobile drawer whenever the route changes (nav item tapped).
  useEffect(() => {
    setMobileNavOpen(false);
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

  // Active rail row — workspace-only now. Project routes light "Projects"; the
  // in-project tab bar carries the sub-context. Docs is lit on its own route.
  const activeKey = useMemo(() => {
    if (pathname.startsWith("/docs")) return "docs";
    if (slug) return "projects";
    const ws = WORKSPACE_ITEMS.find((it) =>
      it.href === "/" ? pathname === "/" : pathname.startsWith(it.href),
    );
    return ws?.key ?? "projects";
  }, [pathname, slug]);

  // The Attention destination shows a live count pill on the rail.
  const railItems = useMemo<NavItem[]>(
    () =>
      WORKSPACE_ITEMS.map((it) =>
        it.key === "attention" ? { ...it, badge: attentionCount } : it,
      ),
    [attentionCount],
  );

  function navigate(key: string) {
    if (key === "docs") {
      router.push("/docs");
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
      { key: "activity", label: "Activity", icon: "activity" },
      { key: "search", label: "Search", icon: "search" },
      { key: "you", label: "You", icon: "settings" },
    ],
    [attentionCount],
  );

  const bottomActiveKey = useMemo(() => {
    if (slug || pathname === "/") return "projects";
    if (pathname.startsWith("/attention")) return "attention";
    if (pathname.startsWith("/activity")) return "activity";
    if (pathname.startsWith("/settings")) return "you";
    return "";
  }, [pathname, slug]);

  function onBottomSelect(key: string) {
    switch (key) {
      case "projects":
        router.push("/");
        break;
      case "attention":
        router.push("/attention");
        break;
      case "activity":
        router.push("/activity");
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
          onRun: () => (it.href ? router.push(it.href) : router.push(`/projects/${slug}${it.sub ?? ""}`)),
        });
      }
    }

    // Actions — wired to existing handlers/routes only; no fabricated endpoints.
    out.push({
      label: "Create issue",
      icon: "plus",
      group: "actions",
      keywords: "new issue",
      onRun: () =>
        slug
          ? router.push(`/projects/${slug}/issues`)
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
      {/* Desktop rail — workspace-only, hidden below md where the bottom tab bar
          + project-switch drawer take over. */}
      <div className="hidden h-full md:block">
        <NavRail
          workspaceItems={railItems}
          activeKey={activeKey}
          onNavigate={navigate}
          onDocs={() => router.push("/docs")}
          onAccount={() => router.push("/settings")}
          onSignOut={logout}
          user={userInitials ? { initials: userInitials } : undefined}
          collapsed={sidebar.collapsed}
          onToggleCollapsed={sidebar.toggleCollapsed}
        />
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
              <button
                type="button"
                onClick={() => router.push("/")}
                className="fg-caption rounded-sm text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                View all
              </button>
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
            onMenu={() => setMobileNavOpen(true)}
            onCommandPalette={() => setPaletteOpen(true)}
            onNotifications={() => setNotificationsOpen((o) => !o)}
            onNewIssue={() =>
              slug
                ? router.push(`/projects/${slug}/issues`)
                : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" })
            }
            density={density}
            onDensityChange={setDensity}
            scrolled={scrolled}
            backToClassicHref="/"
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
