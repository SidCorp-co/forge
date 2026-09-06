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
  // cm:why 600, the same number `jobs/job-token.ts` pins: the measured peak of one busy session is 108 calls in a minute, and the 60 this shipped with (ISS-150) throttled a plugin session at 4 Hz within the first minute. Per-token overrides come from `personal_access_tokens.rate_limit_max`.
  patPerToken: { windowMs: 60_000, max: 600, by: 'token' },
  // cm:why 32^7 + a 10-min TTL already makes guessing a code infeasible; these two caps exist for the other attack — an anonymous `init` caller filling device_login_codes with pending rows.
  deviceLoginInit: { windowMs: 60 * 60_000, max: 20, by: 'ip' },
  deviceLoginApprove: { windowMs: 60 * 60_000, max: 10, by: 'ip' },
  // cm:guard these three all embed caller-supplied text through the shared embeddings provider, so an unthrottled member is unbounded LiteLLM spend — a new route that embeds needs its own bucket here, keyed by user id (requireAuth sets it, falling back to IP), and never a shared one, or one store's traffic spends another's budget.
  memoryWrite: { windowMs: 60_000, max: 30, by: 'user' },
  memorySearch: { windowMs: 60_000, max: 60, by: 'user' },
  knowledgeSearch: { windowMs: 60_000, max: 60, by: 'user' },
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
  deviceLoginInit: resolve(
    DEFAULTS.deviceLoginInit,
    env.RATE_LIMIT_DEVICE_LOGIN_INIT_MAX,
    env.RATE_LIMIT_DEVICE_LOGIN_INIT_WINDOW_MS,
  ),
  deviceLoginApprove: resolve(
    DEFAULTS.deviceLoginApprove,
    env.RATE_LIMIT_DEVICE_LOGIN_APPROVE_MAX,
    env.RATE_LIMIT_DEVICE_LOGIN_APPROVE_WINDOW_MS,
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
  knowledgeSearch: resolve(
    DEFAULTS.knowledgeSearch,
    env.RATE_LIMIT_KNOWLEDGE_SEARCH_MAX,
    env.RATE_LIMIT_KNOWLEDGE_SEARCH_WINDOW_MS,
  ),
};
