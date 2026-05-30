"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  NavRail,
  TopBar,
  CommandPalette,
  NotificationsMenu,
  type NavItem,
  type Command,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";

/** Workspace-tier nav: keys are globally unique (project-tier keys are
 *  prefixed `proj-`) so a single `activeKey` never lights two rows. */
const WORKSPACE_ITEMS: Array<NavItem & { href: string }> = [
  { key: "projects", label: "Projects", icon: "folder", href: "/" },
  { key: "activity", label: "Activity", icon: "activity", href: "/activity" },
  { key: "runners", label: "Runners", icon: "server", href: "/runners" },
  { key: "sessions", label: "Sessions", icon: "agent", href: "/sessions" },
  { key: "pipeline-ops", label: "Pipeline ops", icon: "pipeline", href: "/pipeline" },
];

/** Project-tier nav, relative to `/projects/[slug]`. `sub` is appended to the
 *  project base; the Overview row has an empty `sub` (the base itself). */
const PROJECT_ITEMS: Array<NavItem & { sub: string }> = [
  { key: "proj-overview", label: "Overview", icon: "grid", sub: "" },
  { key: "proj-issues", label: "Issues", icon: "list", sub: "/issues" },
  { key: "proj-pipeline", label: "Pipeline", icon: "pipeline", sub: "/pipeline" },
  { key: "proj-sessions", label: "Sessions", icon: "agent", sub: "/sessions" },
  { key: "proj-chat", label: "Chat", icon: "mail", sub: "/agent" },
  { key: "proj-skills", label: "Skills", icon: "star", sub: "/skills" },
  { key: "proj-schedules", label: "Schedules", icon: "calendar", sub: "/schedules" },
  { key: "proj-context", label: "Context", icon: "inbox", sub: "/context" },
  { key: "proj-pm", label: "PM", icon: "shield", sub: "/pm" },
  { key: "proj-settings", label: "Settings", icon: "settings", sub: "/settings" },
];

/** Parse the active project slug out of the (basePath-stripped) pathname. */
function activeSlug(pathname: string): string | null {
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m ? m[1] : null;
}

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { user, isLoading } = useAuth();
  const { toast } = useToast();
  const { data: projects } = useProjects();

  // Auth gate: once /auth/me has resolved, an unauthenticated visitor is sent
  // to /login (which also makes logout() "return here" effective). While the
  // session is still hydrating we render the shell rather than flash a redirect.
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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
        it.sub === "" ? rest === "" : rest === it.sub || rest.startsWith(`${it.sub}/`),
      );
      return match?.key ?? "proj-overview";
    }
    const ws = WORKSPACE_ITEMS.find((it) =>
      it.href === "/" ? pathname === "/" : pathname.startsWith(it.href),
    );
    return ws?.key ?? "projects";
  }, [pathname, slug]);

  function navigate(key: string) {
    const ws = WORKSPACE_ITEMS.find((it) => it.key === key);
    if (ws) {
      router.push(ws.href);
      return;
    }
    const proj = PROJECT_ITEMS.find((it) => it.key === key);
    if (proj && slug) router.push(`/projects/${slug}${proj.sub}`);
  }

  const navProject = slug
    ? {
        name: activeProject?.name ?? slug,
        initials: projectInitials(activeProject?.name ?? slug),
        ...projectGlyph(activeProject?.id ?? slug),
      }
    : undefined;

  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : undefined;

  const commands: Command[] = useMemo(() => {
    const base: Command[] = WORKSPACE_ITEMS.map((it) => ({
      label: it.label,
      icon: it.icon,
      onRun: () => router.push(it.href),
    }));
    // Searchable project switcher: one jump command per project the caller can
    // reach. Opened from the NavRail project button (or ⌘K directly).
    for (const p of projects ?? []) {
      base.push({
        label: `Switch to ${p.name}`,
        icon: "folder",
        onRun: () => router.push(`/projects/${p.slug}`),
      });
    }
    if (slug) {
      for (const it of PROJECT_ITEMS) {
        base.push({
          label: `${activeProject?.name ?? slug} · ${it.label}`,
          icon: it.icon,
          onRun: () => router.push(`/projects/${slug}${it.sub}`),
        });
      }
    }
    return base;
  }, [router, slug, activeProject, projects]);

  return (
    <div className="flex h-dvh overflow-hidden bg-app">
      <NavRail
        workspaceItems={WORKSPACE_ITEMS}
        projectItems={navProject ? PROJECT_ITEMS : []}
        activeKey={activeKey}
        onNavigate={navigate}
        onProjectSwitch={() => setPaletteOpen(true)}
        project={navProject}
        user={userInitials ? { initials: userInitials } : undefined}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative">
          <TopBar
            onCommandPalette={() => setPaletteOpen(true)}
            onNotifications={() => setNotificationsOpen((o) => !o)}
            onNewIssue={() =>
              toast({ title: "New issue", description: "Coming soon.", tone: "info" })
            }
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

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
