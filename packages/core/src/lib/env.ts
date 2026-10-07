import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  DEVICE_TOKEN_PEPPER: z.string().min(32),
  PAT_PEPPER: z.string().min(32).optional(),
  RATE_LIMIT_PAT_READ_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_PAT_READ_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_PAT_WRITE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_PAT_WRITE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  PAT_MAX_PER_USER: z.coerce.number().int().positive().default(20),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_DEBUG: z
    .enum(['true', 'false', '1', '0'], {
      error: (i) =>
        `SMTP_DEBUG must be one of true, false, 1, 0 (or unset); got ${JSON.stringify(i.input)}`,
    })
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  PUBLIC_API_BASE_URL: z.url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  RATE_LIMIT_AUTH_LOCAL_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_LOCAL_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_INIT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_INIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_APPROVE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_APPROVE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_WRITE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_WRITE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  /** How long a collector window may keep collecting before it is due regardless of quiet (ISS-1086). */
  CONVERSATION_WINDOW_HOLD_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_KNOWLEDGE_SEARCH_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_KNOWLEDGE_SEARCH_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_BACKLOG_STREAM_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_BACKLOG_STREAM_WINDOW_MS: z.coerce.number().int().positive().optional(),
  EMBEDDINGS_BASE_URL: z.url().optional(),
  EMBEDDINGS_API_KEY: z.string().min(1).optional(),
  EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1536),
  EMBEDDINGS_FALLBACK_MODEL: z.string().min(1).optional(),
  EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ADMIN_EMAILS: z.string().optional(),
  /** The project whose releases are Forge's own: What's new reads its released notes for every person. */
  FORGE_PLATFORM_PROJECT_ID: z
    .uuid({
      error: "FORGE_PLATFORM_PROJECT_ID is the uuid of the project whose releases are Forge's own",
    })
    .optional(),
  UPLOADS_DIR: z.string().default('./uploads'),
  UPLOADS_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  UPLOADS_INLINE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  STORAGE_DRIVER: z
    .enum(['local'], {
      error: (issue) =>
        issue.input === 's3'
          ? "STORAGE_DRIVER=s3 is refused: no object-storage driver is built, so 's3' would accept the config and fail on the first upload; the only valid value is 'local'"
          : undefined,
    })
    .default('local'),
  LITELLM_API_URL: z.url().optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  LITELLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  LITELLM_FAST_MODEL: z.string().min(1).optional(),
  LITELLM_FAST_REASONING_EFFORT: z
    .enum(['none', 'minimal', 'low', 'medium', 'high'])
    .default('none'),
  /** Reasoning effort for the CHAT turn; unset sends no field, which is what every endpoint accepted before. */
  CHAT_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
  RERANK_MODEL: z.string().min(1).optional(),
  CHAT_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(80_000),
  ANTHROPIC_API_URL: z.url().default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  OAUTH_REDIRECT_BASE: z.url().optional(),

  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),

  GOOGLE_OIDC_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().min(1).optional(),

  OIDC_LABEL: z.string().min(1).default('Continue with SSO'),
  OIDC_ISSUER_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().min(1).default('openid email profile'),
  FEEDBACK_MAX_PER_JOB: z.coerce.number().int().positive().default(5),
  DATABASE_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

/**
 * The pepper every PAT was hashed with while PAT_PEPPER had a built-in default. A PAT hashed under it
 * still verifies and is rehashed under the configured pepper on use; the amnesty ends when no live
 * hash is left unproven (`.forge/conformance.json` $amnesties, credentials/pat.ts:countUnprovenPatPeppers).
 */
export const LEGACY_PAT_PEPPER = 'dev-pat-pepper-replace-in-production-0123456789';

const DEPLOYED_ENVS: ReadonlySet<string> = new Set(['production', 'staging']);

/** What the schema cannot say alone: the settings a deployed core refuses to boot without. */
function deployedEnvIssues(parsed: Env): string[] {
  if (!DEPLOYED_ENVS.has(parsed.NODE_ENV)) return [];
  if (parsed.PAT_PEPPER === undefined) {
    return [
      `  - PAT_PEPPER: required when NODE_ENV=${parsed.NODE_ENV}; set a random value of at least 32 characters (openssl rand -hex 32). It has no built-in default.`,
    ];
  }
  if (parsed.PAT_PEPPER === LEGACY_PAT_PEPPER) {
    return [
      `  - PAT_PEPPER: is the retired built-in default, which is public in the source; set a random value of at least 32 characters.`,
    ];
  }
  return [];
}

const RETIRED_ENV_VARS: Record<string, string> = {
  RATE_LIMIT_PAT_MAX: 'RATE_LIMIT_PAT_READ_MAX and RATE_LIMIT_PAT_WRITE_MAX',
  RATE_LIMIT_PAT_WINDOW_MS: 'RATE_LIMIT_PAT_READ_WINDOW_MS and RATE_LIMIT_PAT_WRITE_WINDOW_MS',
};

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const cleanedEnv = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
  );

  const retired = Object.entries(RETIRED_ENV_VARS).filter(
    ([name]) => cleanedEnv[name] !== undefined,
  );
  if (retired.length > 0) {
    const lines = retired.map(
      ([name, replacement]) => `  - ${name} is retired; set ${replacement}`,
    );
    throw new Error(
      `[@forge/core] Retired environment variable(s) set:\n${lines.join('\n')}\n` +
        'The per-token PAT rate limit is two buckets now, one for reads and one for writes ' +
        '(ISS-961), so the old single value has no meaning to carry over.',
    );
  }

  const parsed = EnvSchema.safeParse(cleanedEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`[@forge/core] Invalid environment:\n${issues}`);
  }
  const deployed = deployedEnvIssues(parsed.data);
  if (deployed.length > 0) {
    throw new Error(`[@forge/core] Invalid environment:\n${deployed.join('\n')}`);
  }

  return parsed.data;
}

let loaded: Env | undefined;

function currentEnv(): Env {
  loaded ??= loadEnv();
  return loaded;
}

export const env: Env = new Proxy({} as Env, {
  get: (_target, prop) => currentEnv()[prop as keyof Env],
  has: (_target, prop) => prop in currentEnv(),
  ownKeys: () => Reflect.ownKeys(currentEnv()),
  getOwnPropertyDescriptor: (_target, prop) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(currentEnv(), prop);
    return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
  },
});
