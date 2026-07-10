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
  SlideOver,
  Icon,
  type NavItem,
  type Command,
  type Crumb,
} from "@/design";
import { ChatScreen } from "@/features/session/components/chat-screen";
import { ChatDock } from "@/features/session/components/chat-dock";
import { cn } from "@/lib/utils/cn";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useProjects, useProjectsConsole } from "@/features/projects/hooks";
import { usePinnedProjects } from "@/features/projects/pins";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { ProjectFlyout } from "@/features/projects/components/project-flyout";
import { ActiveOrgProvider, useActiveOrg } from "@/features/orgs/active-org";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { useAttention } from "@/features/attention/hooks";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import {
  useNotifications,
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  usePendingInvitations,
  useAcceptInvitation,
  useDeclineInvitation,
} from "@/features/notifications/hooks";
import { toNotificationItem, toInvitationItem } from "@/features/notifications/map";
import type { PendingInvitation } from "@/features/notifications/types";
import { ConfirmDialog } from "@/features/orgs/components/confirm-dialog";
import { formatApiError } from "@/lib/api/error";
import {
  type DeliveryNotification,
  useNotificationDelivery,
} from "@/features/notifications/use-notification-delivery";
import { useUnreadIndicator } from "@/features/notifications/use-unread-indicator";
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
  // ISS-628 — workspace resource management, first type = Private Keys.
  { key: "resources", label: "Resources", icon: "lock", href: "/resources" },
  // Promoted from SECONDARY_DESTINATIONS (ISS-433): since ISS-429/431 this is
  // the owner CONNECTION DIRECTORY (manage shared credentials, enable/disable,
  // projects-using-it) — a management surface, not a redundant status view, so
  // it must be discoverable without ⌘K.
  { key: "integrations", label: "Integrations", icon: "link", href: "/integrations" },
];

/** Destinations dropped from the rail to keep it minimal — still reachable via
 *  ⌘K. Settings also lives in the rail's account menu; Attention is folded into
 *  Overview. They are NOT rendered as rail rows. */
const SECONDARY_DESTINATIONS: Array<NavItem & { href: string }> = [
  { key: "attention", label: "Attention", icon: "inbox", href: "/attention" },
  { key: "settings", label: "Settings", icon: "settings", href: "/settings" },
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
  return (
    <ActiveOrgProvider>
      <WorkspaceShell>{children}</WorkspaceShell>
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

  // Header notification bell (ISS-504). Workspace-global: list + unread count
  // are scoped to the current user server-side. Realtime is free — the WS
  // event-router invalidates these exact query keys on notification.created.
  const notificationsQuery = useNotifications();
  const { data: unread } = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  // ISS-597 — pending invitations (Accept/Decline from the bell).
  const pendingQuery = usePendingInvitations();
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();
  const [declineTarget, setDeclineTarget] = useState<PendingInvitation | null>(null);

  const onAccept = useCallback(
    (inv: PendingInvitation) => {
      acceptInvitation.mutate(
        { kind: inv.kind, token: inv.token },
        {
          onSuccess: () =>
            toast({ title: `You joined ${inv.name} as ${inv.role}`, tone: "success" }),
          onError: (err) =>
            toast({ title: "Failed to accept invitation", description: formatApiError(err), tone: "error" }),
        },
      );
    },
    [acceptInvitation, toast],
  );

  const onDeclineConfirm = useCallback(() => {
    if (!declineTarget) return;
    const inv = declineTarget;
    declineInvitation.mutate(
      { kind: inv.kind, token: inv.token },
      {
        onSuccess: () => {
          toast({ title: "Invitation declined", tone: "success" });
          setDeclineTarget(null);
        },
        onError: (err) => {
          toast({ title: "Failed to decline invitation", description: formatApiError(err), tone: "error" });
          setDeclineTarget(null);
        },
      },
    );
  }, [declineTarget, declineInvitation, toast]);

  const notificationRows = useMemo(
    () => notificationsQuery.data?.items ?? [],
    [notificationsQuery.data],
  );

  // Actionable invite items prepended to the bell; passive invitation_received
  // rows are filtered out so each invite appears once (as the actionable item).
  // The passive rows still count toward the unread badge via the unread-count API.
  const pendingItems = useMemo(
    () =>
      (pendingQuery.data ?? []).map((inv) =>
        toInvitationItem(inv, [
          {
            id: "accept",
            label: "Accept",
            variant: "primary",
            loading: acceptInvitation.isPending && acceptInvitation.variables?.token === inv.token,
            disabled: acceptInvitation.isPending || declineInvitation.isPending,
            onClick: () => onAccept(inv),
          },
          {
            id: "decline",
            label: "Decline",
            variant: "ghost",
            loading: declineInvitation.isPending && declineInvitation.variables?.token === inv.token,
            disabled: acceptInvitation.isPending || declineInvitation.isPending,
            onClick: () => setDeclineTarget(inv),
          },
        ]),
      ),
    [pendingQuery.data, acceptInvitation.isPending, acceptInvitation.variables, declineInvitation.isPending, declineInvitation.variables, onAccept],
  );

  // ISS-619 — a dependency-stall wedge's actionable target (the blocker/child
  // issue) can differ from `issueId` (the wedged issue, kept for interventions
  // metric attribution). Give those rows a distinct "Open sub-task" action
  // alongside the default row-click (which still deep-links `issueId`).
  const notificationItems = useMemo(
    () => [
      ...pendingItems,
      ...notificationRows
        .filter((r) => r.type !== "invitation_received")
        .map((row) => {
          if (row.type !== "pipeline_wedge" || !row.secondaryIssueId) return toNotificationItem(row);
          return toNotificationItem(row, [
            {
              id: "open-sub-task",
              label: "Open sub-task",
              variant: "primary",
              onClick: () => {
                markRead.mutate(row.id);
                setNotificationsOpen(false);
                const target = projects?.find((p) => p.id === row.projectId);
                if (target) router.push(`/projects/${target.slug}/issues/${row.secondaryIssueId}`);
              },
            },
          ]);
        }),
    ],
    [pendingItems, notificationRows, markRead, projects, router],
  );
  const onSelectNotification = useCallback(
    (id: string) => {
      const row = notificationRows.find((n) => n.id === id);
      if (row && !row.read) markRead.mutate(id);
      setNotificationsOpen(false);
      if (!row?.issueId || !row.projectId) return; // mark-read only, no dead-end
      const target = projects?.find((p) => p.id === row.projectId);
      if (target) router.push(`/projects/${target.slug}/issues/${row.issueId}`);
    },
    [notificationRows, markRead, projects, router],
  );

  // Realtime delivery bridge (ISS-510): toast + browser channels for incoming
  // `notification.created` events. Mounted here so a click reuses the same
  // mark-read + deep-link path as the bell. The persistent bell itself updates
  // via the event-router's query invalidation — independent of this hook.
  const onDeliveryNavigate = useCallback(
    (n: DeliveryNotification) => {
      markRead.mutate(n.notificationId);
      if (!n.issueId || !n.projectId) return;
      const target = projects?.find((p) => p.id === n.projectId);
      if (target) router.push(`/projects/${target.slug}/issues/${n.issueId}`);
    },
    [markRead, projects, router],
  );
  useNotificationDelivery(onDeliveryNavigate);

  // Always-visible unread indicator (ISS-523): mirror the unread count onto the
  // favicon (a dot) + document title (`(N) Forge`). Same source as the bell, so
  // they never disagree — and it covers the focused-tab case the background-only
  // native notification channel intentionally skips.
  useUnreadIndicator(unread?.count ?? 0);

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
  // Global Agent Chat dock (ISS-500): the "Ask agent" affordance lives in the
  // header so a conversation can be opened from any screen. The open/closed
  // state is owned here (single source) and persisted per tab — reusing the key
  // + `syncTabs: false` that the in-Agents-screen dock used (ISS-378 AC#7), so a
  // tab that had it open keeps it; opening it in one tab must not pop it open in
  // every other tab.
  const [chatOpen, setChatOpen] = usePersistedState("web-v2:agents-chat-open", false, {
    syncTabs: false,
  });
  // Docked-panel width (desktop split view). Per-tab so resizing one tab's panel
  // doesn't reflow another's.
  const [chatWidth, setChatWidth] = usePersistedState<number>("web-v2:agents-chat-width", 420, {
    syncTabs: false,
  });
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

  // Esc closes the notifications dropdown (AC11 — always dismissable).
  useEffect(() => {
    if (!notificationsOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setNotificationsOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notificationsOpen]);

  const slug = activeSlug(pathname);
  const activeProject = useMemo(
    () => (slug ? projects?.find((p) => p.slug === slug) ?? null : null),
    [projects, slug],
  );

  // Cross-org navigation consistency (ISS-470, AC6): OPENING a project that
  // belongs to a different org re-scopes the workspace to that project's org,
  // so the chrome label + console never lie about where you are. setActiveOrg
  // self-guards on no-op and persists via /me/preferences.
  //
  // CRITICAL (ISS-476): this must fire ONLY when the open project actually
  // CHANGES — not on every divergence between the project's org and activeOrgId.
  // A continuous reconcile makes the rail's org switcher dead while a project is
  // open: a deliberate manual switch flips activeOrgId, the effect sees it differ
  // from the (unchanged) open project's org, and snaps it straight back. We track
  // the last slug we re-scoped for so a manual switch on the SAME project sticks;
  // leaving the project (slug → null) resets it so re-entering re-scopes again.
  const { orgs, activeOrgId, setActiveOrg } = useActiveOrg();
  const lastScopedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) {
      lastScopedSlugRef.current = null;
      return;
    }
    const target = activeProject?.orgId;
    if (!target) return; // project row not resolved yet — don't mark as handled
    // `orgs` (useOrgs) and `projects` (useProjects) are independent parallel
    // queries with no ordering guarantee. If projects wins the cold-load race,
    // `orgs` is still [] and membership can't be decided yet — don't mark the
    // slug handled, so the effect retries once orgs arrives. Otherwise a
    // cross-org deep-link would skip the re-scope permanently (ISS-476 review).
    if (orgs.length === 0) return;
    if (slug === lastScopedSlugRef.current) return; // same project: don't fight a manual switch
    lastScopedSlugRef.current = slug;
    // Only re-scope to an org the caller actually belongs to (ISS-472: an org
    // outside `orgs` would resolve straight back and storm setActiveOrg).
    if (target !== activeOrgId && orgs.some((o) => o.id === target)) {
      setActiveOrg(target);
    }
  }, [slug, activeProject?.orgId, activeOrgId, orgs, setActiveOrg]);

  // Remember the last project visited so the rail can keep showing a project
  // context (mark + tier) even on workspace screens — no vanishing block.
  const [lastSlug, setLastSlug] = usePersistedState<string | null>("web-v2:last-project", null);
  useEffect(() => {
    if (slug && slug !== lastSlug) setLastSlug(slug);
  }, [slug, lastSlug, setLastSlug]);

  // Leave project context on a MANUAL cross-org switch (ISS-480). When the rail
  // switcher flips the active org to one that does NOT own the open project, the
  // workspace must stop showing the old org's project — otherwise the rail lies
  // (ORGANIZATION = new org, PROJECT = old org's project). We gate on the
  // PREVIOUS org so this never collides with the ISS-470 AC6 follow-on-open flow,
  // which ends with activeOrgId === the just-opened project's org:
  //   • Open cross-org project: slug changes first with org unchanged → the
  //     `prevOrg === activeOrgId` guard early-returns; the follow-effect then
  //     sets org = project.orgId → this re-runs but now project.orgId ===
  //     activeOrgId → early-returns. Never leaves.
  //   • Manual switch away: org transitions while slug is stable and the project
  //     is foreign → leave once.
  // No setActiveOrg here, so ISS-476 stays intact (no extra PATCH, no revert,
  // no React #185).
  const prevOrgRef = useRef(activeOrgId);
  useEffect(() => {
    const prevOrg = prevOrgRef.current;
    prevOrgRef.current = activeOrgId;
    if (prevOrg === activeOrgId) return; // org unchanged (incl. AC6 set-to-match)
    if (prevOrg == null) return; // initial null→org resolution is not a user switch — AC6 re-scope owns it (ISS-480 review)
    if (!slug || !activeProject) return; // not in a resolved project — fallback handles the rail
    if (activeProject.orgId === activeOrgId) return; // switched INTO the project's org → stay (AC2)
    // Switched to an org that does not own the open project → exit project context.
    setLastSlug(null); // drop the org-agnostic persisted slug so it can't resurrect
    router.push("/projects"); // org-scoped console; shows the empty state for 0-project orgs
  }, [activeOrgId, slug, activeProject, router, setLastSlug]);

  // Rail/switcher project lists are scoped to the active org (ISS-480) so the
  // rail never surfaces a project from a non-active org. The `!activeOrgId ||`
  // guard keeps the pre-resolve / single-org render coherent (mirrors the ⌘K
  // filter below).
  const scopedProjects = useMemo(
    () => (projects ?? []).filter((p) => !activeOrgId || p.orgId === activeOrgId),
    [projects, activeOrgId],
  );

  // The project the rail renders: the one you're in, else the last visited, else
  // your first (pinned-first) project. Lets you re-enter a project from anywhere.
  const railSlug = useMemo(() => {
    if (slug) return slug;
    const list = scopedProjects;
    if (lastSlug && list.some((p) => p.slug === lastSlug)) return lastSlug;
    const pinnedFirst = list.find((p) => pinnedIds.has(p.id));
    return pinnedFirst?.slug ?? list[0]?.slug ?? null;
  }, [slug, lastSlug, scopedProjects, pinnedIds]);
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
      projectsConsole.items
        // Scope the rail switcher to the active org (ISS-480).
        .filter((p) => !activeOrgId || p.orgId === activeOrgId)
        .map((p) => {
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
    [projectsConsole.items, activeOrgId],
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
  // Derived from WORKSPACE_ITEMS so the compact and expanded rails can never
  // drift (ISS-433 live-E2E caught this list as a stale hardcoded duplicate —
  // it was missing the promoted Integrations row).
  const compactWorkspaceItems = useMemo<RailItem[]>(
    () =>
      WORKSPACE_ITEMS.map((it) => ({
        key: it.key,
        label: it.label,
        icon: it.icon,
        ...(it.key === "overview" ? { badge: attentionCount } : {}),
      })),
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

  // Bottom tab bar (<md): ≤5 destinations. Inside a project it swaps to the
  // project tier (PROJECT_ITEMS, incl. Issues) so the desktop rail's project
  // nav has a mobile surface (ISS-514); otherwise it shows the workspace tabs
  // (Search opens ⌘K; You → account). Derived from PROJECT_ITEMS so it can
  // never drift from the rail (ISS-433 gotcha).
  const bottomItems: BottomTabItem[] = useMemo(() => {
    if (slug) {
      return PROJECT_ITEMS.map((it) => ({
        key: it.key,
        label: it.label,
        icon: it.icon,
        badge: it.key === "proj-issues" ? railConsole?.openIssues : undefined,
      }));
    }
    return [
      { key: "projects", label: "Projects", icon: "folder" },
      { key: "attention", label: "Attention", icon: "inbox", badge: attentionCount },
      { key: "usage", label: "Usage", icon: "dollar" },
      { key: "search", label: "Search", icon: "search" },
      { key: "you", label: "You", icon: "settings" },
    ];
  }, [slug, attentionCount, railConsole]);

  const bottomActiveKey = useMemo(() => {
    // Inside a project the bar carries the project tier — light the matching
    // `proj-*` key the same way the rail does (longest `sub` wins).
    if (slug) {
      const base = `/projects/${slug}`;
      const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
      const hit = PROJECT_ITEMS_BY_SPECIFICITY.find((it) => matchesSub(rest, it.sub));
      return hit?.key ?? "proj-overview";
    }
    // "Projects" tab → the list at /projects. The Overview dashboard at `/` is
    // reachable via the drawer/⌘K, not a bottom tab.
    if (pathname.startsWith("/projects")) return "projects";
    if (pathname.startsWith("/attention")) return "attention";
    if (pathname.startsWith("/usage")) return "usage";
    if (pathname.startsWith("/settings")) return "you";
    return "";
  }, [pathname, slug]);

  function onBottomSelect(key: string) {
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

  // Workspace destinations for the mobile drawer: the rail rows plus the two
  // most-wanted secondary destinations (Attention, Settings), so the workspace
  // tier stays reachable from inside a project once the bottom bar shows the
  // project tier (ISS-514). Routed via their key through navigate().
  const drawerWorkspaceItems = useMemo<Array<NavItem & { href: string }>>(
    () => [
      ...WORKSPACE_ITEMS,
      SECONDARY_DESTINATIONS.find((it) => it.key === "attention")!,
      SECONDARY_DESTINATIONS.find((it) => it.key === "settings")!,
    ],
    [],
  );

  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];

    // ISS-477 — ⌘K project results are scoped to the active org (reuses the
    // component-level `scopedProjects`) so the palette never surfaces projects
    // from another org while one is selected (matches every other SPACE surface).

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
    for (const p of scopedProjects) {
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
    for (const p of scopedProjects) {
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
  }, [router, slug, activeProject, scopedProjects, activeOrgId, recents, pinnedViews.views, pinnedIds, toast]);

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
            orgSwitcher={<OrgSwitcher variant="compact" />}
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
              orgSwitcher={<OrgSwitcher variant="expanded" />}
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

      {/* Mobile drawer — the consolidated navigation menu (ISS-514): the active
          project's tier (PROJECT_ITEMS), the workspace destinations, and the
          project switcher. Opened from the TopBar menu button, below md. */}
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
            aria-label="Navigation"
          >
            {/* Org context + switcher (ISS-469) — the rail is hidden below md,
                so the drawer carries the current-org control on mobile. */}
            <div className="px-1.5 pb-3">
              <OrgSwitcher variant="expanded" />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {/* This project — the project tier from the desktop rail. Shown
                  for the rail project (the one you're in, else last-visited) so
                  Issues & co. are always reachable on mobile. */}
              {railSlug && (
                <>
                  <span className="fg-label px-1.5 pb-1 pt-0.5 text-fg">
                    {railProject?.name ?? "This project"}
                  </span>
                  {PROJECT_ITEMS.map((it) => {
                    const active = it.key === activeKey;
                    const badge = it.key === "proj-issues" ? railConsole?.openIssues : undefined;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        onClick={() => {
                          navigate(it.key);
                          setMobileNavOpen(false);
                        }}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                          active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
                        )}
                      >
                        <Icon name={it.icon} size={18} />
                        <span className="min-w-0 flex-1 truncate">{it.label}</span>
                        {badge != null && badge > 0 && (
                          <span className="fg-caption rounded-pill bg-app px-1.5 text-muted">{badge}</span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}

              {/* Workspace — destinations consolidated into the menu so the tier
                  stays reachable once the bottom bar shows the project tier. */}
              <span className="fg-label px-1.5 pb-1 pt-2 text-fg">Workspace</span>
              {drawerWorkspaceItems.map((it) => {
                const active = !slug && it.key === activeKey;
                const badge = it.key === "attention" ? attentionCount : undefined;
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={() => {
                      navigate(it.key);
                      setMobileNavOpen(false);
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                      active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    <Icon name={it.icon} size={18} />
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {badge != null && badge > 0 && (
                      <span className="fg-caption rounded-pill bg-app px-1.5 text-muted">{badge}</span>
                    )}
                  </button>
                );
              })}

              {/* Projects switcher (unchanged behaviour — do not regress). */}
              <div className="flex items-center justify-between px-1.5 pb-1 pt-2">
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
              {scopedProjects.map((p) => {
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
              {scopedProjects.length === 0 && (
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
            notificationCount={unread?.count ?? 0}
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
                <NotificationsMenu
                  items={notificationItems}
                  loading={notificationsQuery.isLoading || pendingQuery.isLoading}
                  error={notificationsQuery.isError || pendingQuery.isError}
                  onRetry={() => {
                    notificationsQuery.refetch();
                    pendingQuery.refetch();
                  }}
                  onSelect={onSelectNotification}
                  onMarkAllRead={() => markAllRead.mutate()}
                />
              </div>
            </>
          )}
        </div>

        {/* Global Agent Chat — opened from the header "Ask agent" action, scoped
            to the active (or last-visited) project so it works from any screen.
            Below md it's a SlideOver overlay; on desktop it's the docked split
            panel rendered as a sibling of this content column (see ChatDock
            below), so the content reflows beside it rather than being covered. */}
        {railProject && (
          <div className="md:hidden">
            <SlideOver
              open={chatOpen}
              onClose={() => setChatOpen(false)}
              title="My conversations"
              width="clamp(560px, 60vw, 1024px)"
              fitBody
            >
              <ChatScreen projectId={railProject.id} />
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
          {children}
        </main>
      </div>

      {/* Desktop split-view dock — a resizable right column beside the content,
          Chrome-side-panel style (the content column above shrinks via flex).
          Self-hides below md (ChatDock is `hidden md:flex`); the mobile overlay
          SlideOver inside the content column covers small screens instead. */}
      {railProject && chatOpen && (
        <ChatDock
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

      {/* ISS-597 — decline confirmation modal */}
      <ConfirmDialog
        open={declineTarget !== null}
        title={`Decline invitation to ${declineTarget?.name ?? ""}?`}
        message={`You will no longer see this invitation in your notifications. You can still accept it via the original email link.`}
        confirmLabel="Yes, decline"
        tone="danger"
        loading={declineInvitation.isPending}
        onConfirm={onDeclineConfirm}
        onClose={() => setDeclineTarget(null)}
      />
    </div>
  );
}
