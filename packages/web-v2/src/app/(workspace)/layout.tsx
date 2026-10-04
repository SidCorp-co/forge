"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BottomTabBar,
  CommandPalette,
  PinnedTabBar,
  type Command,
} from "@/design";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { inActiveOrg } from "@/features/projects/derive";
import { useProjects } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { ActiveOrgProvider } from "@/features/orgs/active-org";
import { useAttention } from "@/features/attention/hooks";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import { useUnblockCascadeToasts } from "@/features/issues/use-unblock-cascade";
import { useOpenCount } from "@/features/notifications/hooks";
import { NotificationsBell } from "@/features/notifications/components/notifications-bell";
import {
  useSidebarContext,
  SidebarProvider,
  useRecents,
  usePinnedViews,
  MobileNavDrawer,
  WORKSPACE_ITEMS,
  SECONDARY_DESTINATIONS,
  PROJECT_ITEMS,
  ecosystemHref,
  activeSlug,
  buildActiveKey,
  buildBottomActiveKey,
  bottomTabItems,
  buildWorkspaceCommands,
  resolveRailSlug,
  useProjectOrgScopeSync,
  useRailProjectData,
  CurrentProjectProvider,
} from "@/features/shell";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import { ChatDockProvider, useChatDockState } from "@/features/conversations/dock";
import { useAwaitingApprovalCount } from "@/features/releases/hooks";
import { useDesignsAwaitingCount } from "@/features/workflows/hooks";
import { WorkspaceSidebar } from "@/features/shell/components/workspace-sidebar";
import { SidebarSearch } from "@/features/shell/components/sidebar-search";
import { SidebarBell } from "@/features/shell/components/sidebar-bell";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { TopBarSlotProvider } from "@/design";
import { SidebarVersion } from "@/features/shell/components/sidebar-version";
import { DrawerAccount } from "@/features/shell/components/drawer-account";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <ActiveOrgProvider>
      <SidebarProvider>
        <WorkspaceShell>{children}</WorkspaceShell>
      </SidebarProvider>
    </ActiveOrgProvider>
  );
}

function useShellProject(pathname: string) {
  const { data: projects } = useProjects();
  const { pinnedIds } = usePinnedProjects();
  const selected = activeSlug(pathname);
  const selectedProject = useMemo(
    () => (selected ? (projects?.find((p) => p.slug === selected) ?? null) : null),
    [projects, selected],
  );
  const { activeOrgId, lastSlug } = useProjectOrgScopeSync({
    slug: selected,
    activeProject: selectedProject,
    exitTo: "/projects",
  });
  const scopedProjects = useMemo(
    () => (projects ?? []).filter((p) => inActiveOrg(p, activeOrgId)),
    [projects, activeOrgId],
  );
  const lastRailSlugRef = useRef<string | null>(null);
  const railSlug = useMemo(
    () =>
      resolveRailSlug({
        slug: selected,
        lastSlug,
        stickySlug: lastRailSlugRef.current,
        scopedProjects,
        pinnedIds,
      }),
    [selected, lastSlug, scopedProjects, pinnedIds],
  );
  useEffect(() => {
    if (railSlug) lastRailSlugRef.current = railSlug;
  }, [railSlug]);
  const railProject = useMemo(
    () => (railSlug ? (projects?.find((p) => p.slug === railSlug) ?? null) : null),
    [projects, railSlug],
  );
  return { selectedProject, activeOrgId, scopedProjects, pinnedIds, railSlug, railProject };
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const locationSearch = useLocationSearch();
  const { user, isLoading, logout } = useAuth();
  useUnblockCascadeToasts();
  const { toast } = useToast();
  const sidebar = useSidebarContext();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { total: attentionCount } = useAttention();
  const { data: openCount } = useOpenCount();
  const { hasUnseen: whatsNewUnseen } = useWhatsNewStatus();

  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const { selectedProject, activeOrgId, scopedProjects, pinnedIds, railSlug, railProject } =
    useShellProject(pathname);
  const dock = useChatDockState(railProject?.id ?? null);
  const awaitingApproval = useAwaitingApprovalCount(railProject?.id);
  const designsAwaiting = useDesignsAwaitingCount(railProject?.id);
  const slug = activeSlug(pathname);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const sidebarBellRef = useRef<HTMLButtonElement>(null);
  const drawerBellRef = useRef<HTMLButtonElement>(null);
  const [bellAnchor, setBellAnchor] = useState(sidebarBellRef);
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a navigation closes the More sheet, so pathname is the trigger rather than an input.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

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

  const activeKey = useMemo(
    () => buildActiveKey(pathname, slug),
    [pathname, slug],
  );
  const rail = useRailProjectData({ railSlug, railProject, activeOrgId });

  const navigate = useCallback(
    (key: string) => {
      if (key === "whats-new") return router.push("/whats-new");
      if (key === "docs") return router.push("/docs");
      const eco = ecosystemHref(key);
      if (eco) return router.push(eco);
      if (key.startsWith("proj-") && railSlug) {
        const item = PROJECT_ITEMS.find((it) => it.key === key);
        if (item) router.push(`/projects/${railSlug}${item.sub}`);
        return;
      }
      const dest =
        WORKSPACE_ITEMS.find((it) => it.key === key) ??
        SECONDARY_DESTINATIONS.find((it) => it.key === key);
      if (dest) router.push(dest.href);
    },
    [router, railSlug],
  );

  const newChat = useCallback(() => {
    if (!dock.projectId) {
      toast({ title: "New chat", description: "Open a project to chat in it.", tone: "info" });
      return;
    }
    dock.show({ kind: "draft", projectId: dock.projectId });
  }, [dock, toast]);

  function onBottomSelect(key: string) {
    if (key === "home") router.push("/");
    else if (key === "chat") dock.toggle();
    else if (key === "attention") router.push("/attention");
    else if (key === "more") setMoreOpen(true);
  }

  const commands: Command[] = useMemo(
    () =>
      buildWorkspaceCommands({
        router,
        slug,
        activeProjectName: selectedProject?.name,
        scopedProjects,
        pinnedIds,
        pinnedViews: pinnedViews.views,
        recents,
        toast,
        onNewChat: newChat,
      }),
    [router, slug, selectedProject, scopedProjects, recents, pinnedViews.views, pinnedIds, toast, newChat],
  );

  const openPalette = () => setPaletteOpen(true);
  const toggleBell = (anchor: typeof sidebarBellRef) => {
    setBellAnchor(anchor);
    setNotificationsOpen((o) => !o);
  };
  const bellCount = openCount?.count ?? 0;
  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : undefined;

  return (
    <ChatDockProvider value={dock}>
    <TopBarSlotProvider>
    <div className="flex h-dvh overflow-hidden bg-app">
      <div className="hidden h-full md:block" data-testid="desktop-sidebar">
        <WorkspaceSidebar
          collapsed={sidebar.collapsed}
          onToggleCollapsed={sidebar.toggleCollapsed}
          groupOpen={sidebar.groupOpen}
          onToggleGroup={sidebar.toggleGroup}
          activeKey={activeKey}
          attentionCount={attentionCount}
          railSlug={railSlug}
          rail={rail}
          badges={{ openIssues: rail.railConsole?.openIssues, awaitingApproval, designsAwaiting }}
          onNavigate={navigate}
          onRoute={(href) => router.push(href)}
          onSignOut={logout}
          userInitials={userInitials}
          search={(variant) => <SidebarSearch onOpen={openPalette} compact={variant === "compact"} icon={variant === "icon"} />}
          bell={<SidebarBell ref={sidebarBellRef} count={bellCount} onToggle={() => toggleBell(sidebarBellRef)} />}
        />
      </div>

      <MobileNavDrawer
        open={moreOpen}
        onClose={closeMore}
        slug={slug}
        railSlug={railSlug}
        railProjectName={railProject?.name}
        activeKey={activeKey}
        attentionCount={attentionCount}
        badges={{ openIssues: rail.railConsole?.openIssues, awaitingApproval, designsAwaiting }}
        scopedProjects={scopedProjects}
        onNavigate={navigate}
        onOpenProject={(s) => router.push(`/projects/${s}`)}
        onCreateProject={() => router.push("/projects?new=1")}
        onViewAllProjects={() => router.push("/projects")}
        version={
          <SidebarVersion
            onWhatsNew={() => router.push("/whats-new")}
            onDocs={() => router.push("/docs")}
            unseen={whatsNewUnseen}
            activeKey={activeKey}
          />
        }
        search={<SidebarSearch onOpen={openPalette} />}
        bell={<SidebarBell ref={drawerBellRef} count={bellCount} onToggle={() => toggleBell(drawerBellRef)} />}
        footer={<DrawerAccount onAccount={() => router.push("/settings")} onSignOut={logout} />}
      />
      <NotificationsBell open={notificationsOpen} onClose={closeNotifications} anchor={bellAnchor} />

      <div className="flex min-w-0 flex-1 flex-col">
        <ShellTopBar chatOpen={dock.open} onToggleChat={dock.toggle} />
        <PinnedTabBar
          tabs={pinnedViews.views}
          activeHref={`${pathname}${locationSearch}`}
          onSelect={(href) => router.push(href)}
          onRemove={pinnedViews.remove}
        />

        <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">
          <CurrentProjectProvider project={railProject}>{children}</CurrentProjectProvider>
        </main>
      </div>

      <ChatDock dock={dock} />

      <BottomTabBar
        items={bottomTabItems(attentionCount)}
        activeKey={buildBottomActiveKey(pathname, moreOpen, dock.open)}
        onSelect={onBottomSelect}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
    </TopBarSlotProvider>
    </ChatDockProvider>
  );
}
