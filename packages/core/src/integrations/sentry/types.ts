import type { IntegrationEnvironment } from '../../db/schema.js';

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
  /** Mirror of the binding environment; convenience for adapter logic. */
  environment: IntegrationEnvironment;
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
