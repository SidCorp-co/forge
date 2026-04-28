/**
 * Public-facing site URL — used for canonical links, OpenGraph metadata, and
 * any documentation snippet that wants to show the user the live host.
 *
 * Read from `NEXT_PUBLIC_APP_URL`. Falls back to localhost so dev builds work
 * without configuration; deployments must set this to their real origin.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
).replace(/\/$/, '');
