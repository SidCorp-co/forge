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
  /**
   * The wildcard site live previews are served under (REQ-39): `<label>.<PREVIEW_DOMAIN>`. Another
   * site from Forge's, so no Forge cookie reaches project code. Unset, previews are refused
   * PREVIEW_DOMAIN_UNCONFIGURED. `host:port` (served over http) only in development and test.
   */
  PREVIEW_DOMAIN: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?$/, {
      error:
        'PREVIEW_DOMAIN is a lower-case host of two or more labels, such as preview.example.dev (a port only in development or test)',
    })
    .optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  /**
   * What this Forge instance calls where it runs (`dev`, `beta`, `production`), and the project that
   * holds its own releases. What's new reads the release of that project whose commit this build is
   * (REQ-40 BC-10); unset, it refuses by name rather than guess an instance's own product.
   */
  FORGE_ENVIRONMENT: z.string().trim().min(1).max(200).optional(),
  FORGE_PRODUCT_PROJECT_ID: z.uuid().optional(),
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
  RATE_LIMIT_SHARE_OPEN_ADDRESS_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_SHARE_OPEN_ADDRESS_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_SHARE_OPEN_TOKEN_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_SHARE_OPEN_TOKEN_WINDOW_MS: z.coerce.number().int().positive().optional(),
  EMBEDDINGS_BASE_URL: z.url().optional(),
  EMBEDDINGS_API_KEY: z.string().min(1).optional(),
  EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1536),
  EMBEDDINGS_FALLBACK_MODEL: z.string().min(1).optional(),
  EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ADMIN_EMAILS: z.string().optional(),
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

/** The registrable site of a host as previews judge it: its last two labels, or an IP or a
 *  single-label host itself. A public suffix of two labels (co.uk) makes it wider than the browser's,
 *  which refuses more, never less. */
export function siteOf(host: string): string {
  const name = host.toLowerCase().replace(/:\d+$/, '').replace(/^\./, '');
  if (/^[0-9.]+$/.test(name)) return name;
  return name.split('.').slice(-2).join('.');
}

/**
 * Why PREVIEW_DOMAIN cannot serve previews, or null: it shares Forge's site or sits under the
 * session cookie's domain, so project code would ride a Forge session as a same-site request, or it
 * carries a port outside development and test.
 */
export function previewDomainIssue(parsed: Env): string | null {
  const domain = parsed.PREVIEW_DOMAIN;
  if (domain === undefined) return null;
  const host = domain.replace(/:\d+$/, '');
  if (host !== domain && DEPLOYED_ENVS.has(parsed.NODE_ENV)) {
    return `PREVIEW_DOMAIN ${domain} names a port, which is served over http; NODE_ENV=${parsed.NODE_ENV} serves previews only at an https host without one`;
  }
  const cookie = parsed.AUTH_COOKIE_DOMAIN?.toLowerCase().replace(/^\./, '');
  if (cookie && (host === cookie || host.endsWith(`.${cookie}`))) {
    return `PREVIEW_DOMAIN ${domain} sits under AUTH_COOKIE_DOMAIN ${parsed.AUTH_COOKIE_DOMAIN}, so every preview would be sent Forge's session cookie; serve previews from another site`;
  }
  const web = new URL(parsed.APP_BASE_URL).hostname;
  if (siteOf(host) === siteOf(web)) {
    return `PREVIEW_DOMAIN ${domain} is the same site (${siteOf(web)}) as the web origin ${parsed.APP_BASE_URL}, so project code could call Forge as a same-site request with the viewer's session; serve previews from another site`;
  }
  return null;
}

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
  const preview = previewDomainIssue(parsed.data);
  const deployed = [
    ...(preview === null ? [] : [`  - PREVIEW_DOMAIN: ${preview}.`]),
    ...deployedEnvIssues(parsed.data),
  ];
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
