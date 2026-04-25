// Notifications endpoints (`/api/notifications/*`) are not yet implemented in
// forge/core. Keep the feature module wired up but flagged off so the web
// client doesn't generate 404s on every page load. Flip to `true` once the
// core endpoints land. See ISS-243.
export const NOTIFICATIONS_ENABLED = false;
