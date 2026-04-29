/**
 * Feature flags for Trunk-Based Development.
 *
 * Code for in-flight v1 epics merges to `main` immediately. Flags allow each
 * epic to be toggled per environment without rebuilding. To override a flag
 * in a given environment, set `FEATURE_<NAME>=true` (or `=false` to disable)
 * in the env (case-insensitive — the key is uppercased automatically).
 *
 * Flow per feature:
 *   1. Add the flag to `flagDefs` below.
 *   2. Gate route mounting / handler logic with `isEnabled(...)`.
 *   3. Merge to main.
 *   4. Disable in a specific env via `FEATURE_X=false` if needed.
 *   5. Remove the flag + the if-branch when feature is permanent (cleanup PR).
 *
 * Defaults: every flag below is `true`. v0.1.x is alpha — operators self-host,
 * we want them to see the full surface area. Operators who explicitly do NOT
 * want a feature can set `FEATURE_X=false` per environment.
 */

const flagDefs = {
  // v1 EPIC 1 — Chat support agent + provider framework (LiteLLM + Gemini SSE).
  // Note: requires LITELLM_API_URL / LITELLM_API_KEY (or Gemini equivalents)
  // for chat to actually function — flag-on without provider env vars will
  // 500 on first chat request. Disable via FEATURE_CHAT_PROVIDER=false if
  // you don't intend to ship chat in your deployment.
  chatProvider: true,

  // v1 EPIC 2 — Runner framework (claude-code + antigravity adapters)
  runnerFramework: true,

  // v1 EPIC 3 — Pipeline control + runner/device fleet observability
  pipelineControl: true,

  // v1 EPIC 4 — Comment mentions + notification fan-out (PR-B)
  commentMentions: true,

  // v1 EPIC 4 — User preferences + storage adapter (PR-C)
  userPreferences: true,

  // v1 EPIC 5 — Knowledge ops + chat config + RAG analytics + domain templates
  // (Chunk A — app_config + domain_templates already merged to main; Chunk B
  //  knowledge health/backfill + retrieval_analytics + webhook adapter still
  //  behind this flag while Chunk B lands incrementally.)
  knowledgeOps: true,

  // v1 EPIC 5 — WebhookSource adapter framework (replaces inline GitHub branch)
  webhookAdapter: true,

  // v1 EPIC 6 — Per-project skill config UI (Settings > Skills page in web).
  // Backend (override CRUD + /effective + skill.updated WS) ships unflagged
  // because it's additive. The web UI surface gates on this flag while the
  // diff editor and packages/dev sync engine land incrementally.
  skillUi: true,

  // ISS-314 — OAuth/OIDC providers (GitHub + Google + generic OIDC).
  // Default-on so the auth surface ships visible. Operators who haven't
  // configured provider env vars (GITHUB_OAUTH_CLIENT_ID / GOOGLE_OIDC_*)
  // will see no buttons — provider rows are read at request time, so the
  // page stays clean. Set FEATURE_SOCIAL_AUTH=false if you want to hide
  // the entire social-auth code path even when env vars are present.
  socialAuth: true,

  // ADR 0017 — Desktop OAuth via PKCE handoff. Gates /api/auth/desktop/*
  // and the Tauri "Sign in with <provider>" buttons. Default-on as of
  // v0.1.19 (the first release that ships the desktop client UI). End-to-end
  // desktop OAuth still requires socialAuth on (above) for the provider
  // start endpoints to be mounted. Set FEATURE_DESKTOP_OAUTH=false to
  // re-disable the API surface (e.g. an operator who explicitly does not
  // want desktop OAuth at all).
  desktopOauth: true,

} as const;

export type FeatureFlag = keyof typeof flagDefs;

function readEnv(flag: FeatureFlag): boolean {
  const envKey = `FEATURE_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
  const v = process.env[envKey];
  if (v === undefined) return flagDefs[flag];
  return v === 'true' || v === '1';
}

export function isEnabled(flag: FeatureFlag): boolean {
  return readEnv(flag);
}

/** Snapshot of all flag values right now — for `/api/admin/health` or debug. */
export function snapshotFlags(): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>;
  for (const k of Object.keys(flagDefs) as FeatureFlag[]) {
    out[k] = readEnv(k);
  }
  return out;
}
