/**
 * The two cookie names, apart from the module that sets them.
 *
 * `cookie.ts` reaches for `env`, `jwt.ts` and `refresh-token.ts` to build a
 * cookie; a caller that only wants to *read* one — the bearer reader, the
 * device middlewares that must not read one at all — should not have to boot
 * the environment to learn a string.
 */

export const AUTH_COOKIE_NAME = 'forge_auth';

export const REFRESH_COOKIE_NAME = 'forge_refresh';
