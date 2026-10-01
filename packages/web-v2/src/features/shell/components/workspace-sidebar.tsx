"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { NavRail } from "@/design";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { ProjectFlyout } from "@/features/projects/components/project-flyout";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import { NavRailCompact } from "../nav-rail-compact";
import { SidebarVersion } from "./sidebar-version";
import {
  ECOSYSTEM_ITEMS,
  ECOSYSTEM_RAIL_KEYS,
  type ProjectBadges,
  compactWorkspaceRailItems,
  projectMenu,
  projectRailItems,
  workspaceNavItems,
} from "../nav-model";
import type { useRailProjectData } from "../use-rail-project-data";

const ECOSYSTEM_FILTER_KEYS = new Set(
  ECOSYSTEM_ITEMS.filter((it) => it.status).map((it) => it.key),
);

export interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupOpen: Record<string, boolean>;
  onToggleGroup: (key: string, open?: boolean) => void;
  activeKey: string;
  attentionCount: number;
  railSlug: string | null;
  rail: ReturnType<typeof useRailProjectData>;
  badges: ProjectBadges;
  onNavigate: (key: string) => void;
  onRoute: (href: string) => void;
  onSignOut: () => void;
  userInitials: string | undefined;
  search: (variant: "compact" | "icon") => React.ReactNode;
  bell: React.ReactNode;
}

function useFlyoutHover() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  const enter = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  }, []);
  const leave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 150);
  }, []);
  return { open, setOpen, enter, leave };
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const { collapsed, activeKey, attentionCount, rail, onRoute, badges } = props;
  const { hasUnseen } = useWhatsNewStatus();
  const flyout = useFlyoutHover();
  const workspaceItems = useMemo(() => workspaceNavItems(attentionCount), [attentionCount]);
  const footer = {
    onAccount: () => onRoute("/settings"),
    onSignOut: props.onSignOut,
  };
  const version = (compact: boolean) => (
    <SidebarVersion
      onWhatsNew={() => onRoute("/whats-new")}
      onDocs={() => onRoute("/docs")}
      unseen={hasUnseen}
      activeKey={activeKey}
      compact={compact}
    />
  );

  if (collapsed) {
    return (
      <NavRailCompact
        workspaceItems={compactWorkspaceRailItems(attentionCount)}
        projectItems={rail.compactActiveProject ? projectRailItems(badges) : null}
        ecosystemItems={ECOSYSTEM_ITEMS.filter((it) => ECOSYSTEM_RAIL_KEYS.has(it.key))}
        activeKey={ECOSYSTEM_FILTER_KEYS.has(activeKey) ? "eco-channel" : activeKey}
        activeSlug={props.railSlug}
        activeProject={rail.compactActiveProject}
        switcherProjects={rail.switcherProjects}
        onNavigate={props.onNavigate}
        onSelectProject={(s) => onRoute(`/projects/${s}`)}
        onTogglePin={rail.togglePin}
        onAllProjects={() => onRoute("/projects")}
        onNewProject={() => onRoute("/projects?new=1")}
        userInitials={props.userInitials}
        orgSwitcher={<OrgSwitcher variant="compact" />}
        onExpand={props.onToggleCollapsed}
        version={version(true)}
        search={props.search("compact")}
        bell={props.bell}
        {...footer}
      />
    );
  }

  return (
    <>
      <NavRail
        workspaceItems={workspaceItems}
        project={rail.projectMark}
        projectClusters={rail.projectMark ? [{ key: "project", kicker: "Project", items: projectMenu(badges) }] : undefined}
        workspaceClusters={
          rail.projectMark ? [{ key: "ecosystem", kicker: "Ecosystem", items: ECOSYSTEM_ITEMS, collapsible: true }] : undefined
        }
        groupOpen={props.groupOpen}
        onToggleGroup={props.onToggleGroup}
        onProjectSwitch={() => flyout.setOpen((o) => !o)}
        onSwitcherEnter={flyout.enter}
        onSwitcherLeave={flyout.leave}
        activeKey={activeKey}
        onNavigate={props.onNavigate}
        user={props.userInitials ? { initials: props.userInitials } : undefined}
        orgSwitcher={<OrgSwitcher variant="brand" />}
        onToggleCollapsed={props.onToggleCollapsed}
        version={version(false)}
        brandSearch={props.search("icon")}
        bell={props.bell}
        {...footer}
      />
      <ProjectFlyout
        open={flyout.open}
        onClose={() => flyout.setOpen(false)}
        activeSlug={props.railSlug}
        onPanelEnter={flyout.enter}
        onPanelLeave={flyout.leave}
        onViewAll={() => onRoute("/projects")}
        onCreateProject={() => onRoute("/projects?new=1")}
      />
    </>
  );
}
