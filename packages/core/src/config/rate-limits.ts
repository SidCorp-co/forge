import { env } from './env.js';

export type RateLimitRule = {
  windowMs: number;
  max: number;
  by: 'ip' | 'user' | 'ip+user' | 'token';
};

const DEFAULTS = {
  authLocal: { windowMs: 15 * 60_000, max: 5, by: 'ip' },
  authRegister: { windowMs: 60 * 60_000, max: 3, by: 'ip' },
  devicesPair: { windowMs: 60 * 60_000, max: 10, by: 'ip' },
  // ISS-150 — Per-PAT rate limit: 60 req/min by default, keyed by the PAT id
  // (`c.get('patTokenId')`). Per-token overrides come from
  // `personal_access_tokens.rate_limit_max` and are applied at call sites.
  patPerToken: { windowMs: 60_000, max: 60, by: 'token' },
} as const satisfies Record<string, RateLimitRule>;

function resolve(
  base: RateLimitRule,
  max: number | undefined,
  windowMs: number | undefined,
): RateLimitRule {
  return {
    by: base.by,
    max: max ?? base.max,
    windowMs: windowMs ?? base.windowMs,
  };
}

export const RULES: Record<keyof typeof DEFAULTS, RateLimitRule> = {
  authLocal: resolve(
    DEFAULTS.authLocal,
    env.RATE_LIMIT_AUTH_LOCAL_MAX,
    env.RATE_LIMIT_AUTH_LOCAL_WINDOW_MS,
  ),
  authRegister: resolve(
    DEFAULTS.authRegister,
    env.RATE_LIMIT_AUTH_REGISTER_MAX,
    env.RATE_LIMIT_AUTH_REGISTER_WINDOW_MS,
  ),
  devicesPair: resolve(
    DEFAULTS.devicesPair,
    env.RATE_LIMIT_DEVICES_PAIR_MAX,
    env.RATE_LIMIT_DEVICES_PAIR_WINDOW_MS,
  ),
  patPerToken: resolve(
    DEFAULTS.patPerToken,
    env.RATE_LIMIT_PAT_MAX,
    env.RATE_LIMIT_PAT_WINDOW_MS,
  ),
};
