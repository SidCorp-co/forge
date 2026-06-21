import type { IntegrationEnvironment } from '../../db/schema.js';

/**
 * Non-secret Sentry target — stored in `integration_connections.config` (jsonb).
 * Carries NO auth token. `host` is the Sentry instance (self-hosted, e.g.
 * `logs.canawan.com`, or SaaS `sentry.io`); the optional slugs scope which
 * org/project the operator works against. Mirrors `PostmanConfig`.
 */
export interface SentryConfig extends Record<string, unknown> {
  /** Sentry host WITHOUT scheme, e.g. 'logs.canawan.com' or 'sentry.io'. */
  host: string;
  /** Optional Sentry organization slug (display + future scoping). */
  organizationSlug?: string;
  /** Optional Sentry project slug (display + future scoping). */
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
