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
  // ADR 0019 — Desktop sign-in pairing code endpoints.
  // pair-init mints a code (anonymous); cap prevents one IP from filling the
  // table with pending rows.
  desktopPairInit: { windowMs: 60 * 60_000, max: 20, by: 'ip' },
  // approve consumes a code with cookie-auth; cap acts as a brute-force guard
  // since 32^7 + 10-min TTL already makes targeted guessing infeasible.
  desktopApprove: { windowMs: 60 * 60_000, max: 10, by: 'ip' },
  // memory-v2 phase 0 — both endpoints embed caller-supplied text via the
  // embeddings provider, so an unthrottled member means unbounded LiteLLM
  // spend. Keyed by user id (requireAuth sets it); falls back to IP.
  memoryWrite: { windowMs: 60_000, max: 30, by: 'user' },
  memorySearch: { windowMs: 60_000, max: 60, by: 'user' },
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
  patPerToken: resolve(DEFAULTS.patPerToken, env.RATE_LIMIT_PAT_MAX, env.RATE_LIMIT_PAT_WINDOW_MS),
  desktopPairInit: resolve(
    DEFAULTS.desktopPairInit,
    env.RATE_LIMIT_DESKTOP_PAIR_INIT_MAX,
    env.RATE_LIMIT_DESKTOP_PAIR_INIT_WINDOW_MS,
  ),
  desktopApprove: resolve(
    DEFAULTS.desktopApprove,
    env.RATE_LIMIT_DESKTOP_APPROVE_MAX,
    env.RATE_LIMIT_DESKTOP_APPROVE_WINDOW_MS,
  ),
  memoryWrite: resolve(
    DEFAULTS.memoryWrite,
    env.RATE_LIMIT_MEMORY_WRITE_MAX,
    env.RATE_LIMIT_MEMORY_WRITE_WINDOW_MS,
  ),
  memorySearch: resolve(
    DEFAULTS.memorySearch,
    env.RATE_LIMIT_MEMORY_SEARCH_MAX,
    env.RATE_LIMIT_MEMORY_SEARCH_WINDOW_MS,
  ),
};
