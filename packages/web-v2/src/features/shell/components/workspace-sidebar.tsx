
import { useMemo } from "react";
import { NavRail } from "@/design";
import { OrgSwitcher } from "@/features/orgs";
import { useMyEcosystems } from "@/features/ecosystem";
import { ProjectSwitcher } from "./project-switcher";
import { useAccountMenu } from "./account-menu";
import { type ActivityWaiting, type ProjectBadges, projectMenu, workspaceNavItems } from "../nav-model";
import type { useRailProjectData } from "../use-rail-project-data";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";

interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupOpen: Record<string, boolean>;
  onChooseGroups: (patch: Record<string, boolean>) => void;
  activeKey: string;
  attentionCount: number;
  /** What the Activity page says waits on the person, read by the route from the page's own query. */
  activityWaiting: ActivityWaiting | undefined;
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
  const account = useAccountMenu(onRoute);
  const ecosystems = useMyEcosystems().data;
  const activity = props.activityWaiting;
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
        version={account.version}
        user={props.userInitials ? { initials: props.userInitials } : undefined}
        onAccount={() => onRoute("/settings")}
        onSignOut={props.onSignOut}
        onToggleCollapsed={props.onToggleCollapsed}
      />
      {account.sheets}
    </>
  );
}
