import { z } from 'zod';

// Empty strings from `${VAR}` in docker-compose collapse to "" not undefined.
// Treat empty as missing so optional fields don't trip on coercion.
const cleanedEnv = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
);

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  DEVICE_TOKEN_PEPPER: z.string().min(32),
  // ISS-150 — Pepper for argon2id hashing of Personal Access Tokens. In
  // production this MUST be set explicitly; in non-prod environments we
  // accept any 32+ char string so test runs work without operator setup.
  PAT_PEPPER: z.string().min(32).default('dev-pat-pepper-replace-in-production-0123456789'),
  RATE_LIMIT_PAT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_PAT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  // Max PATs per user. Increased via env when an operator needs more.
  PAT_MAX_PER_USER: z.coerce.number().int().positive().default(20),
  // SMTP optional — when SMTP_HOST is empty, email send is skipped (logged instead).
  // Email verification is still enforced server-side; users with no SMTP get the
  // verification token via server logs (dev mode) or must self-verify via admin.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_DEBUG: z.coerce.boolean().default(false),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  // Public origin of THIS API (e.g. https://forge-beta-api.sidcorp.co), used to
  // build absolute presigned upload URLs returned by forge_uploads. Distinct
  // from APP_BASE_URL (the web frontend). When unset, forge_uploads returns only
  // the relative uploadPath and the caller prepends its own API origin.
  PUBLIC_API_BASE_URL: z.url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Optional auth-cookie domain. Set to a parent domain like `.example.com`
  // when web + WS live on different subdomains so the cookie is shared.
  // Default unset — cookie is host-scoped to the request hostname.
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  RATE_LIMIT_AUTH_LOCAL_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_LOCAL_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICES_PAIR_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICES_PAIR_WINDOW_MS: z.coerce.number().int().positive().optional(),
  // ADR 0019 — Desktop sign-in pairing endpoints. Defaults in
  // `config/rate-limits.ts`; env overrides let operators widen the cap for
  // NAT'd offices without a redeploy.
  RATE_LIMIT_DESKTOP_PAIR_INIT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DESKTOP_PAIR_INIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DESKTOP_APPROVE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DESKTOP_APPROVE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  // memory-v2 phase 0 — memory write/search both call the embeddings provider
  // per request; the cap bounds per-member LiteLLM spend.
  RATE_LIMIT_MEMORY_WRITE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_WRITE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_WINDOW_MS: z.coerce.number().int().positive().optional(),
  // LiteLLM-compatible embeddings service (ADR 0011, Phase 2.5-F3).
  // Required only when memory indexing / semantic search is exercised; the
  // singleton defers client creation until first use.
  EMBEDDINGS_BASE_URL: z.url().optional(),
  EMBEDDINGS_API_KEY: z.string().min(1).optional(),
  EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1536),
  EMBEDDINGS_FALLBACK_MODEL: z.string().min(1).optional(),
  EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Comma-separated allow-list of admin emails. When unset, all /api/admin/*
  // requests 403. Intentionally NOT a role column on users — deferred until
  // the admin surface stabilises.
  ADMIN_EMAILS: z.string().optional(),
  // Storage root for the local-fs StorageAdapter. New comment attachment
  // uploads land at <UPLOADS_DIR>/comments/<commentId>/<filename>. Existing
  // pre-ISS-277 rows keep their old <UPLOADS_DIR>/<projectId>/<commentId>
  // path on disk — `comment_attachments.path` is opaque so both layouts
  // resolve through the same adapter `get(path)` call.
  UPLOADS_DIR: z.string().default('./uploads'),
  UPLOADS_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // Max bytes an attachment may have before `forge_uploads` action=fetch
  // inlines it into the model context (image block / text). Larger files
  // return metadata + the download URL instead, so a big file never blows the
  // context window or the output-token limit (re-emitted base64 truncates).
  UPLOADS_INLINE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  // Storage backend for comment attachments. `local` writes under UPLOADS_DIR;
  // `s3` is stubbed (calls throw) until the S3 adapter is implemented.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  // v1 EPIC 1 (ISS-270) — chat providers. Gated behind FEATURE_CHAT_PROVIDER;
  // when the flag is off the route is not mounted and these values are
  // ignored. LITELLM_* targets any OpenAI-compatible /v1/chat/completions
  // endpoint (LiteLLM proxy in production); GEMINI_* uses @google/genai.
  LITELLM_API_URL: z.url().optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  LITELLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-1.5-flash'),
  // ISS-314 — OAuth/OIDC providers. All optional; a provider is "enabled"
  // only when its required pair (clientId + clientSecret, plus issuerUrl
  // for generic OIDC) are all set. The frontend fetches the live list from
  // /api/auth/oauth/providers; we never hardcode which buttons render.
  //
  // OAUTH_REDIRECT_BASE is the public origin the provider should send the
  // user back to (e.g. https://your-host.example.com). Defaults to
  // APP_BASE_URL but is split out because some deployments terminate the
  // OAuth callback on a different host (api subdomain) than the SPA.
  OAUTH_REDIRECT_BASE: z.url().optional(),

  // GitHub — plain OAuth 2.0, no id_token. We fetch /user + /user/emails.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),

  // Google — full OIDC. Discovery doc is hardcoded; only id + secret needed.
  GOOGLE_OIDC_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().min(1).optional(),

  // Generic OIDC (Auth0, Keycloak, Authentik, ZITADEL, …). Discovery is
  // pulled from `${OIDC_ISSUER_URL}/.well-known/openid-configuration`.
  OIDC_LABEL: z.string().min(1).default('Continue with SSO'),
  OIDC_ISSUER_URL: z.url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().min(1).default('openid email profile'),
  // ISS-552 (C1) — per-job rate-limit for forge_feedback submit. When a device
  // principal has a resolved active job, submissions beyond this cap return a
  // soft-reject {ok:false, reason:'rate_limited'} rather than a 500.
  FEEDBACK_MAX_PER_JOB: z.coerce.number().int().positive().default(5),
});

// ISS-234 — INTEGRATION_MASTER_KEY is intentionally NOT validated through
// this schema. The vault module reads process.env directly so unit tests that
// mock the DB but never exercise the vault don't trip env validation. The
// vault's boot-time guard (assertVaultBootSafety) catches missing keys when
// any active integration row exists.

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(cleanedEnv);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`[@forge/core] Invalid environment:\n${issues}`);
}

export const env: Env = parsed.data;
