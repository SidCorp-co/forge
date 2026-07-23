// web-v2 shell feature module — cross-cutting UX state for the app shell:
// density, sidebar collapse/clusters, recents, pinned views, deep-links.
export { useSidebar, type SidebarState } from './sidebar';
export { SidebarProvider, useSidebarContext } from './sidebar-context';
export { useRecents, type RecentEntry, type RecentKind } from './recents';
export { usePinnedViews, type PinnedView } from './pinned-views';
export {
  NavRailCompact,
  type NavRailCompactProps,
  type RailItem,
  type SwitcherProject,
} from './nav-rail-compact';
export {
  buildShareLink, decodeFilter, decodeNumber,
} from './deep-link';
export {
  WORKSPACE_ITEMS, SECONDARY_DESTINATIONS, PROJECT_ITEMS,
  PROJECT_ITEMS_BY_SPECIFICITY, activeSlug, matchesSub, buildCrumbs,
  buildActiveKey, buildBottomActiveKey, workspaceNavItems,
  compactWorkspaceRailItems, projectRailItems, bottomTabItems,
  resolveRailSlug,
  type ProjItem,
} from './nav-model';
export { buildWorkspaceCommands, type WorkspaceCommandDeps } from './commands';
export { useProjectOrgScopeSync } from './use-project-org-scope-sync';
export { useRailProjectData } from './use-rail-project-data';
export { MobileNavDrawer, type MobileNavDrawerProps } from './components/mobile-nav-drawer';
