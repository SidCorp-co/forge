export interface SentryTarget {
  label: string;
  organizationSlug?: string;
  projectSlug?: string;
  environment?: string;
  notes?: string;
}

export interface SentryConfig extends Record<string, unknown> {
  host: string;
  targets?: SentryTarget[];
  /** @deprecated ISS-526 — superseded by `targets[]`; read-only back-compat. */
  organizationSlug?: string;
  projectSlug?: string;
}

/** Secret material — encrypted into `integration_connections.secretsEnc`. */
export interface SentrySecrets extends Record<string, unknown> {
  /** Sentry user auth token (`sntryu_…`). Bearer for the REST probe + the MCP env. */
  authToken: string;
  previousAuthToken?: string;
  /** ISO-8601 timestamp; if past, `previousAuthToken` is ignored. */
  previousTokenExpiresAt?: string;
}

export const SENTRY_ISSUE_STATUSES = [
  'resolved',
  'resolvedInNextRelease',
  'ignored',
  'unresolved',
] as const;
export type SentryIssueStatus = (typeof SENTRY_ISSUE_STATUSES)[number];

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
