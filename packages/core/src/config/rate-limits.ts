import { env } from './env.js';

export type RateLimitRule = {
  windowMs: number;
  max: number;
  by: 'ip' | 'user' | 'ip+user' | 'token';
};

/**
 * A dispatcher plus the four to six agents it runs, and one spare. Not a
 * capacity plan — the number of sessions that were observed sharing one
 * credential when the single 600/min bucket started refusing ordinary reads
 * (ISS-961, forge-plugin's box, 2026-09-07).
 */
const SESSIONS_PER_TOKEN = 8;

/**
 * Roughly 3x the 108-calls-a-minute steady peak one session was measured at,
 * because a single `forge next --why` fans out over every open issue and a
 * session's reads arrive in bursts rather than at its average.
 */
const PER_SESSION_READ_BUDGET = 300;

const DEFAULTS = {
  authLocal: { windowMs: 15 * 60_000, max: 5, by: 'ip' },
  authRegister: { windowMs: 60 * 60_000, max: 3, by: 'ip' },
  devicesPair: { windowMs: 60 * 60_000, max: 10, by: 'ip' },
  patRead: { windowMs: 60_000, max: SESSIONS_PER_TOKEN * PER_SESSION_READ_BUDGET, by: 'token' },
  patWrite: { windowMs: 60_000, max: 600, by: 'token' },
  deviceLoginInit: { windowMs: 60 * 60_000, max: 20, by: 'ip' },
  deviceLoginApprove: { windowMs: 60 * 60_000, max: 10, by: 'ip' },
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
  patRead: resolve(
    DEFAULTS.patRead,
    env.RATE_LIMIT_PAT_READ_MAX,
    env.RATE_LIMIT_PAT_READ_WINDOW_MS,
  ),
  patWrite: resolve(
    DEFAULTS.patWrite,
    env.RATE_LIMIT_PAT_WRITE_MAX,
    env.RATE_LIMIT_PAT_WRITE_WINDOW_MS,
  ),
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

/** Which of the two per-token buckets a PAT request charges. */
export type PatRequestClass = 'read' | 'write';

export function patRuleFor(requestClass: PatRequestClass): RateLimitRule {
  return requestClass === 'read' ? RULES.patRead : RULES.patWrite;
}
