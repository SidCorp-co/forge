// web-v2 feature module: integrations hub. Types verified against
// `GET /api/projects/:projectId/integrations/status` in
// `packages/core/src/integrations/routes.ts` (ISS-305).

export type CardStatus = "connected" | "attention" | "error" | "not_configured";

export interface StatusCard {
  key: string;
  label: string;
  status: CardStatus;
  detail: string;
  /** ISO timestamp of the last real sync/health-check, or null when none exists. */
  lastSyncAt: string | null;
  configured: boolean;
  meta?: Record<string, unknown>;
}

export interface IntegrationsStatus {
  cards: StatusCard[];
}
