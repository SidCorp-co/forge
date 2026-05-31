"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  NavRail,
  TopBar,
  CommandPalette,
  NotificationsMenu,
  PinnedTabBar,
  type NavItem,
  type NavCluster,
  type Command,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import {
  DensityProvider,
  useDensity,
  useSidebar,
  useRecents,
  usePinnedViews,
} from "@/features/shell";

/** Workspace-tier nav: keys are globally unique (project-tier keys are
 *  prefixed `proj-`) so a single `activeKey` never lights two rows. */
const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  { key: "projects", label: "Projects", icon: "folder", href: "/" },
  { key: "activity", label: "Activity", icon: "activity", href: "/activity" },
  { key: "runners", label: "Runners", icon: "server", href: "/runners" },
  { key: "sessions", label: "Sessions", icon: "agent", href: "/sessions" },
  { key: "pipeline-ops", label: "Pipeline ops", icon: "pipeline", href: "/ops" },
];

/** A project-tier nav item. `sub` is appended to `/projects/[slug]`; `href`
 *  routes to an absolute (workspace) target where no project-scoped route
 *  exists yet (Activity / Monitor) — we keep existing targets, not invent. */
interface ProjItem extends NavItem {
  sub?: string;
  href?: string;
}

const PROJECT_WORK: ProjItem[] = [
  { key: "proj-overview", label: "Overview", icon: "grid", sub: "" },
  { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
  { key: "proj-pipeline", label: "Pipeline", icon: "pipeline", sub: "/pipeline" },
  { key: "proj-sessions", label: "Sessions", icon: "agent", sub: "/sessions" },
  { key: "proj-chat", label: "Chat", icon: "mail", sub: "/agent" },
];
const PROJECT_INSIGHT: ProjItem[] = [
  { key: "proj-activity", label: "Activity", icon: "activity", href: "/activity" },
  { key: "proj-monitor", label: "Monitor", icon: "monitor", href: "/ops" },
  { key: "proj-pm", label: "PM", icon: "shield", sub: "/pm" },
];
const PROJECT_CONFIG: ProjItem[] = [
  { key: "proj-context", label: "Context", icon: "inbox", sub: "/context" },
  { key: "proj-skills", label: "Skills", icon: "star", sub: "/skills" },
  { key: "proj-schedules", label: "Schedules", icon: "calendar", sub: "/schedules" },
  { key: "proj-settings", label: "Settings", icon: "settings", sub: "/settings" },
];
const PROJECT_ITEMS: ProjItem[] = [...PROJECT_WORK, ...PROJECT_INSIGHT, ...PROJECT_CONFIG];

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
  const { user, isLoading } = useAuth();
  const { toast } = useToast();
  const { data: projects } = useProjects();
  const { density, setDensity } = useDensity();
  const sidebar = useSidebar();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { pinnedIds } = usePinnedProjects();

  // Auth gate: once /auth/me has resolved, an unauthenticated visitor is sent
  // to /login (which also makes logout() "return here" effective). While the
  // session is still hydrating we render the shell rather than flash a redirect.
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

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

  // Active nav row — project tier wins when on a /projects/[slug] route.
  const activeKey = useMemo(() => {
    if (slug) {
      const rest = pathname.replace(`/projects/${slug}`, "") || "";
      const match = PROJECT_ITEMS.find((it) =>
        it.sub == null
          ? false
          : it.sub === ""
            ? rest === ""
            : rest === it.sub || rest.startsWith(`${it.sub}/`),
      );
      return match?.key ?? "proj-overview";
    }
    const ws = WORKSPACE_ITEMS.find((it) =>
      it.href === "/" ? pathname === "/" : pathname.startsWith(it.href),
    );
    return ws?.key ?? "projects";
  }, [pathname, slug]);

  function navigate(key: string) {
    if (key === "docs") {
      router.push("/docs");
      return;
    }
    const ws = WORKSPACE_ITEMS.find((it) => it.key === key);
    if (ws) {
      router.push(ws.href);
      return;
    }
    const proj = PROJECT_ITEMS.find((it) => it.key === key);
    if (!proj) return;
    if (proj.href) router.push(proj.href);
    else if (slug) router.push(`/projects/${slug}${proj.sub ?? ""}`);
  }

  const navProject = slug
    ? {
        name: activeProject?.name ?? slug,
        initials: projectInitials(activeProject?.name ?? slug),
        ...projectGlyph(activeProject?.id ?? slug),
      }
    : undefined;

  const projectClusters: NavCluster[] = useMemo(
    () => [
      { key: "work", kicker: "Work", items: PROJECT_WORK },
      { key: "insight", kicker: "Insight", items: PROJECT_INSIGHT },
      { key: "config", kicker: "Config", items: PROJECT_CONFIG, collapsible: true },
    ],
    [],
  );

  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : undefined;

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

    // Navigate — workspace items, project switcher, project sub-nav.
    for (const it of WORKSPACE_ITEMS) {
      out.push({ label: it.label, icon: it.icon, group: "navigate", onRun: () => router.push(it.href) });
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
      <NavRail
        workspaceItems={WORKSPACE_ITEMS}
        projectClusters={navProject ? projectClusters : []}
        activeKey={activeKey}
        onNavigate={navigate}
        onProjectSwitch={() => setPaletteOpen(true)}
        onDocs={() => router.push("/docs")}
        project={navProject}
        user={userInitials ? { initials: userInitials } : undefined}
        collapsed={sidebar.collapsed}
        onToggleCollapsed={sidebar.toggleCollapsed}
        groupOpen={sidebar.groupOpen}
        onToggleGroup={sidebar.toggleGroup}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative">
          <TopBar
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
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const top = (e.target as HTMLElement).scrollTop;
            setScrolled((s) => (s ? top > 4 : top > 8));
          }}
        >
          {children}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
