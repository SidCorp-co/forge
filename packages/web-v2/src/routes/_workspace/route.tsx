import { Outlet, createFileRoute } from "@tanstack/react-router";
import { WorkspaceLoading } from "./-loading";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "@/lib/navigation/router";
import {
  BottomTabBar,
  CommandPalette,
  PageCommandsProvider,
  PinnedTabBar,
  type Command,
  usePageCommandList,
} from "@/design";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useAuth } from "@/providers/auth-provider";
import { SignInStopped } from "@/features/auth/components/sign-in-stopped";
import { useLoginRedirect } from "@/features/auth/use-login-redirect";
import { useToast } from "@/providers/toast-provider";
import { inActiveOrg } from "@/features/projects";
import { useProjects } from "@/features/projects";
import { useProjectRef } from "@/features/projects/project-ref";
import { usePinnedProjects } from "@/features/projects/pins";
import { ActiveOrgProvider } from "@/features/orgs/active-org";
import { useAttention } from "@/features/attention/hooks";
import { useUnblockCascadeToasts } from "@/features/issues";
import { useOpenCount } from "@/features/notifications";
import { NotificationsBell } from "@/features/notifications";
import {
  useSidebarContext,
  SidebarProvider,
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
} from "@/features/shell";
import { CurrentProjectProvider } from "@/features/projects/current-project";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ProjectListItem } from "@/features/projects";
import type { ChatDockApi } from "@/features/chat-dock";
import { useRecents } from "@/lib/navigation/recents";
import { usePinnedViews } from "@/lib/navigation/pinned-views";
import { ChatDock } from "@/features/conversations/components/chat-dock";
import { ChatDockProvider, useChatDockState } from "@/features/chat-dock";
import { MockupFeedback } from "@/features/feedback";
import { useNeedsYou } from "@/features/needs-you";
import { WorkspaceSidebar } from "@/features/shell/components/workspace-sidebar";
import { SidebarSearch } from "@/features/shell/components/sidebar-search";
import { SidebarBell } from "@/features/shell/components/sidebar-bell";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { TopBarSlotProvider } from "@/design";
import { SidebarVersion } from "@/features/shell/components/sidebar-version";
import { DrawerAccount } from "@/features/shell/components/drawer-account";
import { WhatsNewButton } from "@/features/whats-new/components/whats-new-button";
import { HelpToursButton } from "@/features/tours/components/help-tours-button";
import { type TourRelease, TourReleaseProvider } from "@/features/tours/release-context";
import { useShippedReleases } from "@/features/releases";
import { TourLauncher } from "@/features/tours/components/tour-launcher";
import { WORKSPACE_MAIN, WORKSPACE_PAGE_COLUMN } from "@/design/templates/workspace-frame";

function WorkspaceLayout() {
  return (
    <ActiveOrgProvider>
      <SidebarProvider>
        <WorkspaceShell>
          <Outlet />
        </WorkspaceShell>
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
  const { ref: railRef } = useProjectRef(railSlug);
  return { selectedProject, activeOrgId, scopedProjects, pinnedIds, railSlug, railProject, railRef };
}

/**
 * The release a tour opens: the project's newest shipped one (any release carries a tour's anchors),
 * read only once the tour list asks, so no route but Releases reads the release list (ISS-1070).
 */
function useTourRelease(railRef: string | undefined): TourRelease {
  const [wanted, setWanted] = useState(false);
  const want = useCallback(() => setWanted(true), []);
  const version = useShippedReleases(wanted ? railRef : undefined, 1).data?.releases[0]?.version ?? null;
  return useMemo(() => ({ version, want }), [version, want]);
}

/** ⌘K / Ctrl+K anywhere in the workspace toggles the command palette. */
function usePaletteShortcut(toggle: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** Where a navigation key goes: docs, an ecosystem, a project page under the rail's project, or a workspace page. */
function navigateTo(router: ReturnType<typeof useRouter>, key: string, railSlug: string | null | undefined): void {
  if (key === "docs") return router.push("/docs");
  const eco = ecosystemHref(key);
  if (eco) return router.push(eco);
  if (key.startsWith("proj-") && railSlug) {
    const item = PROJECT_ITEMS.find((it) => it.key === key);
    if (item) router.push(`/projects/${railSlug}${item.sub}`);
    return;
  }
  const dest = WORKSPACE_ITEMS.find((it) => it.key === key) ?? SECONDARY_DESTINATIONS.find((it) => it.key === key);
  if (dest) router.push(dest.href);
}

/** What every page under the shell reads: its project, language, tour, chat dock, top bar and ⌘K acts. */
function ShellContext({
  project,
  projectRef,
  tourRelease,
  dock,
  openPalette,
  children,
}: {
  project: Parameters<typeof CurrentProjectProvider>[0]["project"];
  projectRef: Parameters<typeof CurrentProjectProvider>[0]["projectRef"];
  tourRelease: TourRelease;
  dock: ChatDockApi;
  openPalette: () => void;
  children: React.ReactNode;
}) {
  return (
    <CurrentProjectProvider project={project} projectRef={projectRef}>
      <TourReleaseProvider value={tourRelease}>
          <ChatDockProvider value={dock}>
            <MockupFeedback>
              <TopBarSlotProvider>
                <PageCommandsProvider openPalette={openPalette}>{children}</PageCommandsProvider>
              </TopBarSlotProvider>
            </MockupFeedback>
          </ChatDockProvider>
      </TourReleaseProvider>
    </CurrentProjectProvider>
  );
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const locationSearch = useLocationSearch();
  const { user, isLoading, logout } = useAuth();
  useUnblockCascadeToasts();
  const sidebar = useSidebarContext();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { waitingOnYou: attentionCount } = useAttention();
  const { data: openCount } = useOpenCount();

  const { stopped: signInStopped } = useLoginRedirect(!isLoading && !user, !!user);

  const { selectedProject, activeOrgId, scopedProjects, pinnedIds, railSlug, railProject, railRef } =
    useShellProject(pathname);
  const dock = useChatDockState(railProject?.id ?? null);
  const pageColumnRef = useRef<HTMLDivElement>(null);
  const tourRelease = useTourRelease(railRef);
  // the rail's badges read one Needs you read, its decisions count included: the decisions read is
  // the pages' that list them, never every route's (ISS-1070)
  const needsYou = useNeedsYou(railRef).data;
  const decisions = needsYou ? { total: needsYou.decisions } : undefined;
  const slug = activeSlug(pathname);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const sidebarBellRef = useRef<HTMLButtonElement>(null);
  const drawerBellRef = useRef<HTMLButtonElement>(null);
  const [bellAnchor, setBellAnchor] = useState(sidebarBellRef);
  // The More sheet stands open on the page it was opened on: a navigation closes it.
  const [moreOpenOn, setMoreOpenOn] = useState<string | null>(null);
  const moreOpen = moreOpenOn === pathname;
  const closeMore = () => setMoreOpenOn(null);
  const closeNotifications = () => setNotificationsOpen(false);
  usePaletteShortcut(() => setPaletteOpen((o) => !o));

  const activeKey = buildActiveKey(pathname, slug);
  const rail = useRailProjectData({ railSlug, railProject, activeOrgId });
  const navigate = (key: string) => navigateTo(router, key, railSlug);

  function onBottomSelect(key: string) {
    if (key === "home") router.push("/");
    else if (key === "chat") dock.toggle();
    else if (key === "attention") router.push("/attention");
    else if (key === "more") setMoreOpenOn(pathname);
  }

  const openPalette = () => setPaletteOpen(true);
  const toggleBell = (anchor: typeof sidebarBellRef) => {
    setBellAnchor(anchor);
    setNotificationsOpen((o) => !o);
  };
  const bellCount = openCount?.count ?? 0;
  const userInitials = user?.email ? user.email.slice(0, 2).toUpperCase() : undefined;

  // the previous navigation already bounced to /login and came back: stop and say why, never again
  if (signInStopped) return <SignInStopped />;

  return (
    <ShellContext project={railProject} projectRef={railRef} tourRelease={tourRelease} dock={dock} openPalette={openPalette}>
    <div className="flex h-dvh overflow-hidden bg-shell" data-print="frame" data-shell>
      <div className="hidden h-full md:block" data-testid="desktop-sidebar" data-print="chrome">
        <WorkspaceSidebar
          collapsed={sidebar.collapsed}
          onToggleCollapsed={sidebar.toggleCollapsed}
          groupOpen={sidebar.groupOpen}
          onToggleGroup={sidebar.toggleGroup}
          activeKey={activeKey}
          attentionCount={attentionCount}
          railSlug={railSlug}
          rail={rail}
          badges={{ needsYou, decisions }}
          onNavigate={navigate}
          onRoute={(href) => router.push(href)}
          onSignOut={() => void logout()}
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
        badges={{ needsYou, decisions }}
        scopedProjects={scopedProjects}
        onNavigate={navigate}
        onOpenProject={(s) => router.push(`/projects/${s}`)}
        onCreateProject={() => router.push("/projects?new=1")}
        onViewAllProjects={() => router.push("/projects")}
        version={
          <>
            <WhatsNewButton />
            <HelpToursButton />
            <SidebarVersion
              onDocs={() => router.push("/docs")}
              activeKey={activeKey}
            />
          </>
        }
        search={<SidebarSearch onOpen={openPalette} />}
        bell={<SidebarBell ref={drawerBellRef} count={bellCount} onToggle={() => toggleBell(drawerBellRef)} />}
        footer={<DrawerAccount onAccount={() => router.push("/settings")} onSignOut={() => void logout()} />}
      />
      <NotificationsBell open={notificationsOpen} onClose={closeNotifications} anchor={bellAnchor} />

      {/* data-page: the container the page's breakpoints read while the Ask Agent panel is beside it (globals.css) */}
      <div ref={pageColumnRef} className={WORKSPACE_PAGE_COLUMN} data-print="frame" data-page>
        <div className="contents" data-print="chrome">
          <ShellTopBar chatOpen={dock.open} onToggleChat={dock.toggle} />
          <PinnedTabBar
            tabs={pinnedViews.views}
            activeHref={`${pathname}${locationSearch}`}
            onSelect={(href) => router.push(href)}
            onRemove={pinnedViews.remove}
          />
        </div>

        <main className={WORKSPACE_MAIN} data-print="frame">
          {children}
          <TourLauncher />
        </main>
      </div>

      <div className="contents" data-print="chrome">
        <ChatDock dock={dock} page={pageColumnRef} />

        <BottomTabBar
          items={bottomTabItems(attentionCount)}
          activeKey={buildBottomActiveKey(pathname, moreOpen, dock.open)}
          onSelect={onBottomSelect}
        />
      </div>

      <WorkspacePalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        dock={dock}
        slug={slug}
        activeProjectName={selectedProject?.name}
        scopedProjects={scopedProjects}
        pinnedIds={pinnedIds}
        pinnedViews={pinnedViews.views}
        recents={recents}
      />
    </div>
    </ShellContext>
  );
}

/** The ⌘K palette, built inside the interface language so its entries and its toasts read in it. */
function WorkspacePalette({
  open,
  onClose,
  dock,
  slug,
  activeProjectName,
  scopedProjects,
  pinnedIds,
  pinnedViews,
  recents,
}: {
  open: boolean;
  onClose: () => void;
  dock: ChatDockApi;
  slug: string | null;
  activeProjectName: string | undefined;
  scopedProjects: ProjectListItem[];
  pinnedIds: Set<string>;
  pinnedViews: ReturnType<typeof usePinnedViews>["views"];
  recents: ReturnType<typeof useRecents>["items"];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const language = useInterfaceLanguage();
  const t = useCopy();
  const newChat = useCallback(() => {
    if (!dock.projectId) {
      toast({ title: t("shell.cmd.newChat"), description: t("shell.cmd.newChatNoProject"), tone: "info" });
      return;
    }
    dock.show({ kind: "draft", projectId: dock.projectId });
  }, [dock, toast, t]);
  const pageCommands = usePageCommandList();
  const workspaceCommands: Command[] = useMemo(
    () =>
      buildWorkspaceCommands(
        { router, slug, activeProjectName, scopedProjects, pinnedIds, pinnedViews, recents, toast, onNewChat: newChat },
        language,
      ),
    [router, slug, activeProjectName, scopedProjects, recents, pinnedViews, pinnedIds, toast, newChat, language],
  );
  const commands = useMemo(() => [...pageCommands, ...workspaceCommands], [pageCommands, workspaceCommands]);
  return <CommandPalette open={open} onClose={onClose} commands={commands} />;
}

export const Route = createFileRoute("/_workspace")({ component: WorkspaceLayout, pendingComponent: WorkspaceLoading });
