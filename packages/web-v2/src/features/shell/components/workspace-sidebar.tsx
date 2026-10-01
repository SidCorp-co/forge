"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { NavRail } from "@/design";
import { ChatSidebar } from "@/features/conversations/components/chat-sidebar";
import { OrgSwitcher } from "@/features/orgs/components/org-switcher";
import { ProjectFlyout } from "@/features/projects/components/project-flyout";
import { ForgeVersion } from "@/features/version";
import { useWhatsNewStatus } from "@/features/whats-new/hooks";
import type { ShellMode } from "../mode";
import { NavRailCompact } from "../nav-rail-compact";
import {
  ECOSYSTEM_ITEMS,
  ECOSYSTEM_RAIL_KEYS,
  PROJECT_ITEMS,
  compactWorkspaceRailItems,
  projectRailItems,
  workspaceNavItems,
} from "../nav-model";
import type { useRailProjectData } from "../use-rail-project-data";
import { ModeSwitch } from "./mode-switch";

const ECOSYSTEM_FILTER_KEYS = new Set(
  ECOSYSTEM_ITEMS.filter((it) => it.status).map((it) => it.key),
);

export interface WorkspaceSidebarProps {
  mode: ShellMode;
  onSwitchMode: (to: ShellMode) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupOpen: Record<string, boolean>;
  onToggleGroup: (key: string) => void;
  activeKey: string;
  attentionCount: number;
  railSlug: string | null;
  rail: ReturnType<typeof useRailProjectData>;
  chat: { slug: string | null; conversationId: string | null };
  onNavigate: (key: string) => void;
  onRoute: (href: string) => void;
  onSignOut: () => void;
  userInitials: string | undefined;
  search: (compact: boolean) => React.ReactNode;
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
  const { mode, onSwitchMode, collapsed, activeKey, attentionCount, rail, onRoute } = props;
  const { hasUnseen } = useWhatsNewStatus();
  const flyout = useFlyoutHover();
  const workspaceItems = useMemo(() => workspaceNavItems(attentionCount), [attentionCount]);
  const footer = {
    onDocs: () => onRoute("/docs"),
    onWhatsNew: () => onRoute("/whats-new"),
    whatsNewBadge: hasUnseen ? 1 : 0,
    onAccount: () => onRoute("/settings"),
    onSignOut: props.onSignOut,
  };

  if (mode === "chat") {
    return (
      <NavRail
        workspaceItems={[]}
        activeKey=""
        modeSwitch={<ModeSwitch mode={mode} onSwitch={onSwitchMode} />}
        orgSwitcher={<OrgSwitcher variant="expanded" />}
        bell={props.bell}
        body={
          <ChatSidebar slug={props.chat.slug} conversationId={props.chat.conversationId} onNavigate={onRoute} />
        }
        user={props.userInitials ? { initials: props.userInitials } : undefined}
        version={<ForgeVersion className="fg-caption truncate" />}
        {...footer}
      />
    );
  }

  if (collapsed) {
    return (
      <NavRailCompact
        workspaceItems={compactWorkspaceRailItems(attentionCount)}
        projectItems={rail.compactActiveProject ? projectRailItems(rail.railConsole?.openIssues) : null}
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
        version={<ForgeVersion className="text-9-5 leading-tight" />}
        modeSwitch={<ModeSwitch mode={mode} onSwitch={onSwitchMode} compact />}
        search={props.search(true)}
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
        projectClusters={
          rail.projectMark
            ? [
                { key: "project", kicker: "Project", items: PROJECT_ITEMS },
                { key: "ecosystem", kicker: "Ecosystem", items: ECOSYSTEM_ITEMS, collapsible: true },
              ]
            : undefined
        }
        groupOpen={props.groupOpen}
        onToggleGroup={props.onToggleGroup}
        onProjectSwitch={() => flyout.setOpen((o) => !o)}
        onSwitcherEnter={flyout.enter}
        onSwitcherLeave={flyout.leave}
        activeKey={activeKey}
        onNavigate={props.onNavigate}
        user={props.userInitials ? { initials: props.userInitials } : undefined}
        orgSwitcher={<OrgSwitcher variant="expanded" />}
        onToggleCollapsed={props.onToggleCollapsed}
        version={<ForgeVersion className="fg-caption truncate" />}
        modeSwitch={<ModeSwitch mode={mode} onSwitch={onSwitchMode} />}
        search={props.search(false)}
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
