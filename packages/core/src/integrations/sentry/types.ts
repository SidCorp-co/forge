/**
 * One labelled Sentry target (ISS-526). A Forge project that spans several
 * Sentry projects (backend / frontend / mobile) records one target per stack.
 * All targets share the connection's single host + auth token; `label` is the
 * human name the agent disambiguates on, the slugs scope a Sentry MCP call,
 * `environment` is a free display label, `notes` is free-text agent guidance.
 */
export interface SentryTarget {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

/**
 * Non-secret Sentry config — stored in `integration_connections.config` (jsonb).
 * Carries NO auth token. `host` is the Sentry instance (self-hosted, e.g.
 * `logs.canawan.com`, or SaaS `sentry.io`); `targets` is the labelled list of
 * org/project the operator works against (ISS-526). The legacy top-level slugs
 * (ISS-524) are kept optional for back-compat reads of pre-ISS-526 connections.
 */
export interface SentryConfig extends Record<string, unknown> {
  /** Sentry host WITHOUT scheme, e.g. 'logs.canawan.com' or 'sentry.io'. */
  host: string;
  /** Labelled Sentry targets (ISS-526). One per stack/project. */
  targets?: SentryTarget[];
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  organizationSlug?: string;
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  projectSlug?: string;
}

/** Secret material — encrypted into `integration_connections.secretsEnc`. */
export interface SentrySecrets extends Record<string, unknown> {
  /** Sentry user auth token (`sntryu_…`). Bearer for the REST probe + the MCP env. */
  authToken: string;
  /**
   * Previous auth token, retained during the rotation window so a healthcheck
   * issued before the new token propagates can still authenticate. Mirrors the
   * coolify/postman dual-token pattern (ISS-405).
   */
  previousAuthToken?: string;
  /** ISO-8601 timestamp; if past, `previousAuthToken` is ignored. */
  previousTokenExpiresAt?: string;
}

/**
 * The four values Sentry's issue-update endpoint accepts for `status`.
 *
 * `resolvedInNextRelease` is the one this loop leans on and it is NOT a synonym for `resolved`
 * (ISS-1085): a Forge issue closes carrying `mergedCommitSha`, which says the fix is merged and
 * says nothing about it serving. Marking such an issue `resolved` would be contradicted by the very
 * next event off the still-running release and read as a false regression.
 */
export const SENTRY_ISSUE_STATUSES = [
  'resolved',
  'resolvedInNextRelease',
  'ignored',
  'unresolved',
] as const;
export type SentryIssueStatus = (typeof SENTRY_ISSUE_STATUSES)[number];

/**
 * What core keeps of one Sentry issue.
 *
 * Split on purpose: everything above `title` is structural — an id, a count, a timestamp, an
 * enum — and is safe to render or compare. The last three are text a Sentry EVENT carried, which
 * is usually text some user typed into the app that crashed.
 */
// cm:guard the three free-text fields are already char-stripped by `sanitizeUntrusted` on the way in, which removes invisible/bidi smuggling and unwraps HTML comments — it does NOT frame them as data. The projection that renders them to an agent is a Forge issue filed by `sentry/intake.ts` (slice 3), and the frame is applied THERE-ward rather than at the write: `prompt/user.ts` frames `issue.title` and `issue.description` for the pipeline prompt and `mcp/tools/forge-issues.ts:serialize` frames both for the MCP single-issue projection. Do NOT store a frame with the text — `markUntrusted` runs `stripFrameTokens` over its own input, so a stored frame is destroyed by the projection frame and the text ends up bare. The one agent-facing projection that does not frame is `serializeListRow`, by the priced decision in its own `cm:why` (the token cap), recorded at `docs/proposals/an-mcp-list-title-is-char-stripped-and-not-framed.md`.
export interface SentryIssueDetail {
  id: string;
  shortId: string | null;
  status: string | null;
  substatus: string | null;
  level: string | null;
  count: number | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  projectSlug: string | null;
  /** Free text from the event. */
  title: string | null;
  /** Free text from the event. */
  culprit: string | null;
  /** Free text from the event — `metadata.value`, typically the exception message. */
  metadataValue: string | null;
}
