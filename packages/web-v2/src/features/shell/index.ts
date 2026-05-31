// web-v2 shell feature module — cross-cutting UX state for the app shell:
// density, sidebar collapse/clusters, recents, pinned views, deep-links.
export { DensityProvider, useDensity, type Density } from './density';
export { useSidebar, type SidebarState } from './sidebar';
export { useRecents, type RecentEntry, type RecentKind } from './recents';
export { usePinnedViews, type PinnedView } from './pinned-views';
export {
  buildShareLink, encodeFilters, decodeFilter, decodeNumber,
} from './deep-link';
