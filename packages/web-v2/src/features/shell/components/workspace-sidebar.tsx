"use client";

import { useMemo } from "react";
import { NavRail } from "@/design";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { useMyEcosystems } from "@/features/ecosystem/hooks";
import { ProjectSwitcher } from "./project-switcher";
import { HelpToursButton } from "@/features/tours/components/help-tours-button";
import { tourShowMe } from "@/features/tours/components/tour-show-me";
import { WhatsNewButton } from "@/features/whats-new/components/whats-new-button";
import { SidebarVersion } from "./sidebar-version";
import { type ProjectBadges, projectMenu, workspaceNavItems } from "../nav-model";
import type { useRailProjectData } from "../use-rail-project-data";

interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupOpen: Record<string, boolean>;
  onToggleGroup: (key: string, open: boolean) => void;
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

/** The desktop sidebar: one NavRail, compact or labelled, fed by the one nav model. */
export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const { collapsed, activeKey, attentionCount, rail, onRoute, badges } = props;
  const ecosystems = useMyEcosystems().data;
  const workspaceItems = useMemo(() => workspaceNavItems(attentionCount, ecosystems), [attentionCount, ecosystems]);
  const projectItems = rail.projectMark ? projectMenu(badges) : undefined;

  return (
    <NavRail
      compact={collapsed}
      workspaceItems={workspaceItems}
      projectItems={projectItems}
      activeKey={activeKey}
      onNavigate={props.onNavigate}
      groupOpen={props.groupOpen}
      onToggleGroup={props.onToggleGroup}
      projectSwitcher={
        <ProjectSwitcher
          compact={collapsed}
          project={rail.projectMark}
          projects={rail.switcherProjects}
          activeSlug={props.railSlug}
          onSelect={(s) => onRoute(`/projects/${s}`)}
          onSettings={(s) => onRoute(`/projects/${s}/settings`)}
          onTogglePin={rail.togglePin}
          onAllProjects={() => onRoute("/projects")}
          onNewProject={() => onRoute("/projects?new=1")}
        />
      }
      orgSwitcher={<OrgSwitcher variant={collapsed ? "compact" : "brand"} />}
      search={props.search(collapsed ? "compact" : "icon")}
      bell={props.bell}
      version={
        <>
          <WhatsNewButton compact={collapsed} entryAction={tourShowMe} />
          <HelpToursButton compact={collapsed} />
          <SidebarVersion onDocs={() => onRoute("/docs")} activeKey={activeKey} compact={collapsed} />
        </>
      }
      user={props.userInitials ? { initials: props.userInitials } : undefined}
      onAccount={() => onRoute("/settings")}
      onSignOut={props.onSignOut}
      onToggleCollapsed={props.onToggleCollapsed}
    />
  );
}
