/**
 * Feature flags for Trunk-Based Development.
 *
 * Code for in-flight v1 epics merges to `main` immediately, gated behind a
 * flag so it's invisible until the epic is QA'd. To enable a flag in a given
 * environment, set `FEATURE_<NAME>=true` in the env (case-insensitive — the
 * key is uppercased automatically).
 *
 * Flow per feature:
 *   1. Add the flag to `flagDefs` below with `false` default.
 *   2. Gate route mounting / handler logic with `isEnabled(...)`.
 *   3. Merge to main behind the flag (default off everywhere).
 *   4. Enable in staging env via `FEATURE_X=true` for QA.
 *   5. Enable in production env once stable.
 *   6. Remove the flag + the if-branch when feature is permanent (cleanup PR).
 */

const flagDefs = {
  // v1 EPIC 1 — Chat support agent + provider framework (LiteLLM + Gemini SSE)
  chatProvider: false,

  // v1 EPIC 2 — Runner framework (claude-code + antigravity adapters)
  runnerFramework: false,

  // v1 EPIC 3 — Pipeline control + runner/device fleet observability
  pipelineControl: false,

  // v1 EPIC 4 — Comment mentions + notification fan-out (PR-B)
  commentMentions: false,

  // v1 EPIC 4 — User preferences + storage adapter (PR-C)
  userPreferences: false,

  // v1 EPIC 5 — Knowledge ops + chat config + RAG analytics + domain templates
  // (Chunk A — app_config + domain_templates already merged to main; Chunk B
  //  knowledge health/backfill + retrieval_analytics + webhook adapter still
  //  behind this flag while Chunk B lands incrementally.)
  knowledgeOps: false,

  // v1 EPIC 5 — WebhookSource adapter framework (replaces inline GitHub branch)
  webhookAdapter: false,

  // v1 EPIC 6 — Per-project skill config UI (Settings > Skills page in web).
  // Backend (override CRUD + /effective + skill.updated WS) ships unflagged
  // because it's additive. The web UI surface gates on this flag while the
  // diff editor and packages/dev sync engine land incrementally.
  skillUi: false,

  // ISS-314 — OAuth/OIDC providers (GitHub + Google + generic OIDC). Surface
  // is fully gated until the flag flips so the public auth pages stay clean
  // even if env vars are accidentally set in a non-rolled-out environment.
  socialAuth: false,

  // ADR 0017 — Desktop OAuth via PKCE handoff. Gates /api/auth/desktop/*
  // and the Tauri "Sign in with <provider>" buttons. Default-on as of
  // v0.1.19 (the first release that ships the desktop client UI). Operators
  // who haven't deployed the v0.1.19 desktop binary still need socialAuth
  // on for end-to-end OAuth to function — desktopOauth alone only enables
  // the API surface, the Tauri UI is the actual gate users see. Set
  // FEATURE_DESKTOP_OAUTH=false to re-disable the API surface (e.g. an
  // operator who explicitly does not want desktop OAuth at all).
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
