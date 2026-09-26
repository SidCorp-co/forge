"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  NavRail,
  BottomTabBar,
  type BottomTabItem,
  TopBar,
  CommandPalette,
  PinnedTabBar,
  SlideOver,
  ProjectMark,
  type NavItem,
  type Command,
  type Crumb,
  useMediaQuery,
} from "@/design";
import { ConversationDock } from "@/features/conversations/components/conversation-dock";
import { ConversationPanel } from "@/features/conversations/components/conversation-panel";
import { useConversationDock } from "@/features/conversations/use-conversation-dock";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { ProjectFlyout } from "@/features/projects/components/project-flyout";
import { ActiveOrgProvider } from "@/features/orgs/active-org";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { useAttention } from "@/features/attention/hooks";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import { ForgeVersion } from "@/features/version";
import { useUnblockCascadeToasts } from "@/features/issues/use-unblock-cascade";
import { useOpenCount } from "@/features/notifications/hooks";
import { NotificationsBell } from "@/features/notifications/components/notifications-bell";
import {
  useSidebarContext,
  SidebarProvider,
  useRecents,
  usePinnedViews,
  NavRailCompact,
  MobileNavDrawer,
  type RailItem,
  WORKSPACE_ITEMS,
  SECONDARY_DESTINATIONS,
  PROJECT_ITEMS,
  activeSlug,
  buildActiveKey,
  buildBottomActiveKey,
  buildCrumbs,
  workspaceNavItems,
  compactWorkspaceRailItems,
  projectRailItems,
  bottomTabItems,
  buildWorkspaceCommands,
  resolveRailSlug,
  useProjectOrgScopeSync,
  useRailProjectData,
  CurrentProjectProvider,
} from "@/features/shell";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <ActiveOrgProvider>
      <SidebarProvider>
        <WorkspaceShell>{children}</WorkspaceShell>
      </SidebarProvider>
    </ActiveOrgProvider>
  );
}

function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  // Reactive query string so the pinned-tab bar can exact-match a pin's
  // deep-link (ISS-436 — pathname-only matching lit up EVERY pin on the route).
  const locationSearch = useLocationSearch();
  const { user, isLoading, logout } = useAuth();
  useUnblockCascadeToasts();
  const { toast } = useToast();
  const { data: projects } = useProjects();
  const sidebar = useSidebarContext();
  const { items: recents } = useRecents();
  const pinnedViews = usePinnedViews();
  const { pinnedIds } = usePinnedProjects();
  // Rail + bottom-bar Attention badge. `total` already folds in offline runners.
  const { total: attentionCount } = useAttention();
  // What's New nav badge — shown when the newest changelog entry is unseen.
  const { hasUnseen: whatsNewUnseen } = useWhatsNewStatus();

  // TopBar bell badge. The bell cluster itself (dropdown, invitations,
  // delivery + open-indicator bridges) lives in <NotificationsBell> below —
  // this query is shared with it via the React Query cache. ISS-1063: the badge
  // counts records still true for this reader, not deliveries they have not opened.
  const { data: openCount } = useOpenCount();

  // Auth gate: once /auth/me has resolved, an unauthenticated visitor is sent
  // to /login (which also makes logout() "return here" effective). While the
  // session is still hydrating we render the shell rather than flash a redirect.
  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // True when the drawer was opened from the bottom-nav "Project switcher" tab
  // — surfaces the project list first instead of scrolled below This
  // project/Workspace (ISS-685). False from the TopBar menu button.
  const [mobileNavProjectFirst, setMobileNavProjectFirst] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { chatOpen, setChatOpen, chatWidth, setChatWidth } = useConversationDock();
  // One chat surface mounted, never both: a hidden slide-over's Escape closed the dock.
  const chatDocked = useMediaQuery("(min-width: 48rem)");
  const chatInSlideOver = useMediaQuery("not all and (min-width: 48rem)");
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
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);

  // Close the mobile drawer + project flyout whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
    setFlyoutOpen(false);
  }, [pathname]);

  const slug = activeSlug(pathname);
  const activeProject = useMemo(
    () => (slug ? projects?.find((p) => p.slug === slug) ?? null : null),
    [projects, slug],
  );

  // Keep the active-org scope and the open project consistent (ISS-470/476/480)
  // and track the last project visited — see useProjectOrgScopeSync.
  const { activeOrgId, lastSlug } = useProjectOrgScopeSync({ slug, activeProject });

  // Rail/switcher project lists are scoped to the active org (ISS-480) so the
  // rail never surfaces a project from a non-active org. The `!activeOrgId ||`
  // guard keeps the pre-resolve / single-org render coherent (mirrors the ⌘K
  // filter below).
  const scopedProjects = useMemo(
    () => (projects ?? []).filter((p) => !activeOrgId || p.orgId === activeOrgId),
    [projects, activeOrgId],
  );

  // The project the rail renders: the one you're in, else the last visited, else
  // this tab's last-resolved rail project, else your first (pinned-first)
  // project. Lets you re-enter a project from anywhere.
  //
  // `lastRailSlugRef` anchors this tab to the project it was already showing so
  // a `scopedProjects` reorder/refetch (e.g. window-focus refetch of the
  // projects list) can't bounce it onto a shared list[0] — the mechanism
  // behind ISS-734 (same-org tabs converging on one project).
  const lastRailSlugRef = useRef<string | null>(null);
  const railSlug = useMemo(
    () =>
      resolveRailSlug({
        slug,
        lastSlug,
        stickySlug: lastRailSlugRef.current,
        scopedProjects,
        pinnedIds,
      }),
    [slug, lastSlug, scopedProjects, pinnedIds],
  );
  useEffect(() => {
    if (railSlug) lastRailSlugRef.current = railSlug;
  }, [railSlug]);
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

  // Active rail row (proj-* key inside a project) — see buildActiveKey.
  const activeKey = useMemo(() => buildActiveKey(pathname, slug), [pathname, slug]);

  // Breadcrumb trail for the top header (ISS-358; ISS-359 fix) — derivation
  // lives in the shared nav model (buildCrumbs).
  const crumbs = useMemo<Crumb[]>(
    () => buildCrumbs({ pathname, slug, activeKey, projectName: activeProject?.name }),
    [pathname, slug, activeProject, activeKey],
  );

  // Attention is folded into Overview — its live count rides Overview's badge.
  const railItems = useMemo<NavItem[]>(() => workspaceNavItems(attentionCount), [attentionCount]);

  // Rail project context — switcher glyph + the console rollup (liveRuns /
  // openIssues badges). See useRailProjectData.
  const { projectMark, switcherProjects, railConsole, compactActiveProject, togglePin } =
    useRailProjectData({ railSlug, railProject, activeOrgId });

  // Compact-rail tiers — derived from the shared nav model (ISS-433: never
  // hand-duplicate these lists) with the live Attention / open-issues badges.
  const compactWorkspaceItems = useMemo<RailItem[]>(
    () => compactWorkspaceRailItems(attentionCount),
    [attentionCount],
  );
  const compactProjectItems = useMemo<RailItem[] | null>(
    () => (compactActiveProject ? projectRailItems(railConsole?.openIssues) : null),
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

  // Bottom tab bar (<md, ISS-514/ISS-681) — tier swap + active key live in
  // nav-model. Inside a project, the "Project" switcher item renders the
  // project's ProjectMark glyph for parity with the desktop rail/flyout
  // (folder icon fallback when no rail project is resolved yet).
  const bottomItems: BottomTabItem[] = useMemo(() => {
    const items = bottomTabItems(slug, attentionCount, railConsole?.openIssues);
    if (!slug || !projectMark) return items;
    return items.map((it) =>
      it.key === "switcher"
        ? {
            ...it,
            leading: (
              <ProjectMark
                tint={projectMark.tint}
                ink={projectMark.ink}
                initials={projectMark.initials}
                size={22}
                radius="var(--r-sm)"
              />
            ),
          }
        : it,
    );
  }, [slug, attentionCount, railConsole, projectMark]);

  // Chat lights the "Chat" tab while the mobile chat overlay is open, taking
  // priority over the route-derived key (ISS-681).
  const bottomActiveKey = useMemo(
    () => (chatOpen && slug ? "chat" : buildBottomActiveKey(pathname, slug)),
    [pathname, slug, chatOpen],
  );

  function onBottomSelect(key: string) {
    // Chat/switcher are project-tier actions, not routes — handle them before
    // the proj- route check so they never fall through to navigate() (ISS-681).
    if (key === "chat") {
      if (railProject) setChatOpen((v) => !v);
      else toast({ title: "Ask agent", description: "Open a project to ask the agent.", tone: "info" });
      return;
    }
    if (key === "switcher") {
      setMobileNavProjectFirst(true);
      setMobileNavOpen(true);
      return;
    }
    // Project-tier keys route through the shared navigate() (it already pushes
    // /projects/<railSlug><sub>); workspace keys keep their dedicated handlers.
    if (key.startsWith("proj-")) {
      navigate(key);
      return;
    }
    switch (key) {
      case "projects":
        router.push("/projects");
        break;
      case "attention":
        router.push("/attention");
        break;
      case "search":
        setPaletteOpen(true);
        break;
      case "you":
        router.push("/settings");
        break;
    }
  }

  // ⌘K command registry — built in features/shell/commands. `activeOrgId`
  // stays a dep because `scopedProjects` derives from it (ISS-477 scoping).
  const commands: Command[] = useMemo(
    () =>
      buildWorkspaceCommands({
        router,
        slug,
        activeProjectName: activeProject?.name,
        scopedProjects,
        pinnedIds,
        pinnedViews: pinnedViews.views,
        recents,
        toast,
      }),
    [router, slug, activeProject, scopedProjects, activeOrgId, recents, pinnedViews.views, pinnedIds, toast],
  );

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
            onTogglePin={togglePin}
            onAllProjects={() => router.push("/projects")}
            onNewProject={() => router.push("/projects?new=1")}
            onAccount={() => router.push("/settings")}
            onSignOut={logout}
            userInitials={userInitials}
            orgSwitcher={<OrgSwitcher variant="compact" />}
            onExpand={sidebar.toggleCollapsed}
            onWhatsNew={() => router.push("/whats-new")}
            whatsNewBadge={whatsNewUnseen ? 1 : 0}
            onDocs={() => router.push("/docs")}
            version={<ForgeVersion className="text-9-5 leading-tight" />}
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
              orgSwitcher={<OrgSwitcher variant="expanded" />}
              onToggleCollapsed={sidebar.toggleCollapsed}
              version={<ForgeVersion className="fg-caption truncate" />}
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

      {/* Mobile drawer — the consolidated navigation menu (ISS-514). Opened
          from the TopBar menu button, below md. */}
      <MobileNavDrawer
        open={mobileNavOpen}
        onClose={closeMobileNav}
        projectFirst={mobileNavProjectFirst}
        slug={slug}
        railSlug={railSlug}
        railProjectName={railProject?.name}
        activeKey={activeKey}
        attentionCount={attentionCount}
        openIssuesBadge={railConsole?.openIssues}
        scopedProjects={scopedProjects}
        onNavigate={navigate}
        onOpenProject={(s) => router.push(`/projects/${s}`)}
        onCreateProject={() => router.push("/projects?new=1")}
        onViewAllProjects={() => router.push("/projects")}
        version={<ForgeVersion className="fg-caption" />}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative">
          <TopBar
            breadcrumb={crumbs}
            onBreadcrumbNavigate={(href) => router.push(href)}
            onMenu={
              slug
                ? undefined
                : () => {
                    setMobileNavProjectFirst(false);
                    setMobileNavOpen(true);
                  }
            }
            onCommandPalette={() => setPaletteOpen(true)}
            onNotifications={() => setNotificationsOpen((o) => !o)}
            notificationsRef={bellRef}
            notificationCount={openCount?.count ?? 0}
            onNewIssue={() =>
              slug
                ? router.push(`/projects/${slug}/issues?new=1`)
                : toast({ title: "New issue", description: "Open a project to create an issue.", tone: "info" })
            }
            askAgentActive={chatOpen}
            onAskAgent={() =>
              railProject
                ? setChatOpen((v) => !v)
                : toast({ title: "Ask agent", description: "Open a project to ask the agent.", tone: "info" })
            }
            scrolled={scrolled}
          />
          {/* Bell dropdown + invitations + realtime delivery/open-count bridges
              (ISS-504/597/510/523) — always mounted, dropdown gated on open. */}
          <NotificationsBell open={notificationsOpen} onClose={closeNotifications} anchor={bellRef} />
        </div>

        {railProject && (
          <div className="md:hidden">
            <SlideOver
              open={chatOpen && chatInSlideOver}
              onClose={() => setChatOpen(false)}
              title="My conversations"
              width="clamp(560px, 60vw, 1024px)"
              fitBody
              hideHeader
            >
              <ConversationPanel projectId={railProject.id} onClose={() => setChatOpen(false)} />
            </SlideOver>
          </div>
        )}

        <PinnedTabBar
          tabs={pinnedViews.views}
          activeHref={`${pathname}${locationSearch}`}
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
          <CurrentProjectProvider project={railProject}>{children}</CurrentProjectProvider>
        </main>
      </div>

      {railProject && chatOpen && chatDocked && (
        <ConversationDock
          projectId={railProject.id}
          width={chatWidth}
          onWidthChange={setChatWidth}
          onClose={() => setChatOpen(false)}
        />
      )}

      <BottomTabBar items={bottomItems} activeKey={bottomActiveKey} onSelect={onBottomSelect} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
