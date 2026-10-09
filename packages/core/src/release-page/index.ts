// The release page domain (REQ-40): one release as a reader reads it, its drafted highlights, and
// the `release` share subject.
export { readReleasePage } from './read.js';
export {
  backgroundRefreshesSettled,
  refreshReleaseHighlights,
  registerReleaseHighlightsRefresh,
} from './refresh.js';
export { releasePageRoutes } from './routes.js';
export { releaseShareSource } from './share-source.js';
