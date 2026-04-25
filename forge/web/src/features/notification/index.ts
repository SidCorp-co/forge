// Notifications endpoints (`/api/notifications/*`) are mounted in forge/core
// as of ISS-258 (Tier B2 phase 1). This flag is kept as a kill-switch in case
// the backend has to be temporarily disabled, but should stay `true` in v0.1+.
export const NOTIFICATIONS_ENABLED = true;
