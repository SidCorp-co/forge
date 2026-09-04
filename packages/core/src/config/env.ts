import { z } from 'zod';

// cm:why empty strings from `${VAR}` in docker-compose collapse to "" not undefined, so treat empty as missing or an optional field trips on coercion of a variable the operator never set
const cleanedEnv = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
);

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  DEVICE_TOKEN_PEPPER: z.string().min(32),
  // cm:guard ISS-150 — PAT_PEPPER MUST be set explicitly in production: the default below exists only so non-prod test runs work without operator setup, and shipping it live makes every PAT hash forgeable by anyone reading this file
  PAT_PEPPER: z.string().min(32).default('dev-pat-pepper-replace-in-production-0123456789'),
  RATE_LIMIT_PAT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_PAT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  PAT_MAX_PER_USER: z.coerce.number().int().positive().default(20),
  // cm:why SMTP is optional — an empty SMTP_HOST skips the send and logs instead, but email verification stays enforced server-side, so a deployment without SMTP hands out the token via server logs (dev mode) or an admin self-verify
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_DEBUG: z.coerce.boolean().default(false),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  // cm:guard PUBLIC_API_BASE_URL is the origin of THIS API, NOT APP_BASE_URL (the web frontend) — it builds the absolute presigned upload URLs forge_uploads returns, and while unset forge_uploads emits only the relative uploadPath for the caller to prefix; AUTH_COOKIE_DOMAIN likewise needs a parent domain like `.example.com` when web and WS sit on different subdomains, or the cookie stays host-scoped and the WS handshake is unauthenticated
  PUBLIC_API_BASE_URL: z.url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  RATE_LIMIT_AUTH_LOCAL_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_LOCAL_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICES_PAIR_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICES_PAIR_WINDOW_MS: z.coerce.number().int().positive().optional(),
  // cm:why every rate-limit default lives in `config/rate-limits.ts` and these overrides only let an operator widen one without a redeploy — ADR 0019 for the desktop pairing endpoints (a NAT'd office shares one IP), and for the memory pair because write and search each call the embeddings provider per request, so the cap bounds per-member spend; that provider (EMBEDDINGS_*, ADR 0011 Phase 2.5-F3) is OpenAI-compatible, needed only when memory indexing or semantic search runs, and its singleton defers client creation to first use
  RATE_LIMIT_DEVICE_LOGIN_INIT_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_INIT_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_APPROVE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DEVICE_LOGIN_APPROVE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_WRITE_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_WRITE_WINDOW_MS: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_MAX: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_MEMORY_SEARCH_WINDOW_MS: z.coerce.number().int().positive().optional(),
  EMBEDDINGS_BASE_URL: z.url().optional(),
  EMBEDDINGS_API_KEY: z.string().min(1).optional(),
  EMBEDDINGS_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDINGS_DIM: z.coerce.number().int().positive().default(1536),
  EMBEDDINGS_FALLBACK_MODEL: z.string().min(1).optional(),
  EMBEDDINGS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // cm:guard ADMIN_EMAILS is a comma-separated allow-list and every /api/admin/* request 403s while it is unset — deliberately not a role column on users, deferred until the admin surface stabilises; under UPLOADS_DIR two on-disk layouts are live, new attachments at <UPLOADS_DIR>/comments/<commentId>/<filename> and pre-ISS-277 rows at <UPLOADS_DIR>/<projectId>/<commentId>, and both resolve through one adapter `get(path)` because `comment_attachments.path` is opaque
  ADMIN_EMAILS: z.string().optional(),
  UPLOADS_DIR: z.string().default('./uploads'),
  UPLOADS_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // cm:guard above UPLOADS_INLINE_MAX_BYTES `forge_uploads` action=fetch returns metadata plus the download URL rather than inlining the attachment, so a big file never blows the context window or the output-token limit (re-emitted base64 truncates); STORAGE_DRIVER=`s3` is a STUB whose calls throw, so only `local` (under UPLOADS_DIR) is a working backend
  UPLOADS_INLINE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  // cm:guard LITELLM_* names the deployment's PROXY, not a vendor — one OpenAI-compatible /v1/chat/completions endpoint now serves both readers, the `openai` chat adapter (ISS-270, gated by FEATURE_CHAT_PROVIDER) and the system-job fast model in `memory/llm.ts`, so unsetting LITELLM_API_URL takes memory-v2 extraction, consolidation and auto-titling down with chat, and both readers MUST build the URL through lib/openai-compat-url.ts — they disagreed on whether the value carried `/v1` until 2026-09-04 and memory 404'd on a proxy that serves only `/v1/...`; there is no second vendor path left to fall back on since GEMINI_* was deleted 2026-09-04
  LITELLM_API_URL: z.url().optional(),
  LITELLM_API_KEY: z.string().min(1).optional(),
  LITELLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  LITELLM_FAST_MODEL: z.string().min(1).optional(),
  LITELLM_FAST_REASONING_EFFORT: z
    .enum(['none', 'minimal', 'low', 'medium', 'high'])
    .default('none'),
  RERANK_MODEL: z.string().min(1).optional(),
  CHAT_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(80_000),
  ANTHROPIC_API_URL: z.url().default('https://api.anthropic.com'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  // cm:why ISS-314 — a provider counts as "enabled" only when its whole required set is present (clientId + clientSecret, plus issuerUrl for generic OIDC) and the frontend renders whatever /api/auth/oauth/providers reports rather than a hardcoded button list; OAUTH_REDIRECT_BASE defaults to APP_BASE_URL but is split out because some deployments terminate the callback on a different host (api subdomain) than the SPA; GitHub is plain OAuth 2.0 with no id_token (we fetch /user + /user/emails), Google is full OIDC on a hardcoded discovery doc, and the generic block (Auth0, Keycloak, Authentik, ZITADEL, …) discovers from `${OIDC_ISSUER_URL}/.well-known/openid-configuration`
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
  // cm:why ISS-552 (C1) — past this many forge_feedback submissions on one device principal's active job the extras soft-reject with {ok:false, reason:'rate_limited'} instead of 500ing; ISS-565 (P1) below moves always/on_demand project facts from agentConfig to knowledge_entries and stays OFF for the deprecation window, until the migrate-project-facts script has run
  FEEDBACK_MAX_PER_JOB: z.coerce.number().int().positive().default(5),
  KNOWLEDGE_INJECTION_ENABLED: z.coerce.boolean().default(false),
  // cm:guard ISS-663 — these bound a hung db.transaction() callback pinning a stale MVCC snapshot on a pooled connection, so they must stay well above any legitimate query duration AND well below the pipeline's RESULT_QUIET_MINUTES=60 job-quiet threshold (loop-monitor.ts): raised past it they start killing long-running pipeline operations that were working
  DATABASE_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // cm:why per-attempt bound on the pg_advisory_xact_lock wait in buildAndEnqueueStepJob (orchestrator.ts); MAX_ADVISORY_LOCK_ATTEMPTS retries at this default stay well under DATABASE_IDLE_IN_TX_TIMEOUT_MS
  PIPELINE_ADVISORY_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
});

// cm:guard ISS-234 — do NOT add INTEGRATION_MASTER_KEY to the schema above: the vault reads process.env directly so that unit tests which mock the DB but never touch the vault do not trip env validation, and assertVaultBootSafety catches a missing key at boot whenever an active integration row exists

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(cleanedEnv);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`[@forge/core] Invalid environment:\n${issues}`);
}

export const env: Env = parsed.data;
