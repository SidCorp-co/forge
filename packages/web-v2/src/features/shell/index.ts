// web-v2 shell feature module — cross-cutting UX state for the app shell:
// density, sidebar collapse/clusters, recents, pinned views, deep-links.
export { useSidebar, type SidebarState } from './sidebar';
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
