
import { useMemo } from "react";
import { type MenuItem, NavRail } from "@/design";
import { OrgSwitcher } from "@/features/orgs";
import { useMyEcosystems } from "@/features/ecosystem";
import { useActivityWaiting } from "@/features/activity";
import { ProjectSwitcher } from "./project-switcher";
import { useHelpTours } from "@/features/tours";
import { ForgeVersion } from "@/features/version";
import { useWhatsNewEntry } from "@/features/whats-new";
import { type ProjectBadges, projectMenu, workspaceNavItems } from "../nav-model";
import type { useRailProjectData } from "../use-rail-project-data";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";

interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupOpen: Record<string, boolean>;
  onChooseGroups: (patch: Record<string, boolean>) => void;
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

/**
 * The account chip's menu beyond Account and Sign out: What's new, Help and the guides, each with its
 * dot, and the version as its last line (ISS-1331); the chip's dot says one of them holds something new.
 */
function useAccountMenu(onRoute: (href: string) => void) {
  const t = useCopy();
  const whatsNew = useWhatsNewEntry();
  const help = useHelpTours();
  const unread = whatsNew.owed ? t("whatsNew.unread") : undefined;
  const changed = help.updated ? t("help.updated") : undefined;
  const menu: MenuItem[] = [
    { label: t("whatsNew.nav"), icon: "star", onSelect: whatsNew.open, dot: unread, separatorBefore: true },
    { label: t("help.nav"), icon: "help", onSelect: help.open, dot: changed },
    { label: t("shell.docs"), icon: "book", onSelect: () => onRoute("/docs") },
  ];
  const sheets = (
    <>
      {whatsNew.sheet}
      {help.sheet}
    </>
  );
  return { menu, dot: unread ?? changed, sheets };
}

/** The desktop sidebar: one NavRail, compact or labelled, fed by the one nav model. */
export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const { collapsed, activeKey, attentionCount, rail, onRoute, badges } = props;
  const account = useAccountMenu(onRoute);
  const ecosystems = useMyEcosystems().data;
  const activity = useActivityWaiting();
  const workspaceItems = useMemo(() => workspaceNavItems(attentionCount, ecosystems, activity), [attentionCount, ecosystems, activity]);
  const language = useInterfaceLanguage();
  const projectItems = rail.projectMark ? projectMenu(badges, language) : undefined;

  return (
    <>
      <NavRail
        compact={collapsed}
        workspaceItems={workspaceItems}
        projectItems={projectItems}
        activeKey={activeKey}
        onNavigate={props.onNavigate}
        groupOpen={props.groupOpen}
        onChooseGroups={props.onChooseGroups}
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
        menu={account.menu}
        menuDot={account.dot}
        version={<ForgeVersion />}
        user={props.userInitials ? { initials: props.userInitials } : undefined}
        onAccount={() => onRoute("/settings")}
        onSignOut={props.onSignOut}
        onToggleCollapsed={props.onToggleCollapsed}
      />
      {account.sheets}
    </>
  );
}
