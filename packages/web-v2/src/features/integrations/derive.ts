// web-v2 integrations directory — pure view-model helpers (ISS-402).
//
// Side-effect-free so they unit-test under the existing pure-vitest setup
// (web-v2 has no jsdom/RTL). The directory cards + connection-detail drawer
// derive their state from the composed status read model
// (`GET /:projectId/integrations/status`) and the adapter `capabilities` it
// carries — never from fabricated health.

import type { IntegrationCapabilities } from "@forge/contracts";
import type { IconName } from "@/design";
import type { StatusCard } from "./types";

/** The four honest directory states (ISS-402, reporter comment e24438a1).
 *  No distinct "Needs-reauth" — that arrives with OAuth-first in ISS-404 (F);
 *  for now a broken credential (breaker open / degraded health) reads Degraded. */
export type DirectoryStatus = "connected" | "degraded" | "error" | "not_connected";

/** Conservative capabilities default — mirrors core `DEFAULT_CAPABILITIES`
 *  (packages/core/src/integrations/types.ts) so an absent `meta.capabilities`
 *  renders the most restrictive archetype (no delivery log, no env split). */
export const DEFAULT_CAPABILITIES: IntegrationCapabilities = {
  canDispatch: false,
  canReceiveWebhook: false,
  injectsMcp: false,
  hasEnvironments: false,
  prodConfirmGate: false,
  hasDeliveryLog: false,
};

/** The provider keys that resolve to a connection/binding the user can drill
 *  into (Test / Rotate / Disconnect + delivery log). Other status cards
 *  (github, runners, postgres, …) are read-only telemetry. */
export const DRILLABLE_PROVIDERS = ["coolify", "postman", "epodsystem"] as const;
export type DrillableProvider = (typeof DRILLABLE_PROVIDERS)[number];

/** Card key → provider; `coolify:staging` and `coolify` both map to `coolify`. */
export function cardProvider(key: string): string {
  return key.split(":")[0] ?? key;
}

/** True when a status card represents a drillable connection provider. */
export function isProviderCard(key: string): boolean {
  return (DRILLABLE_PROVIDERS as readonly string[]).includes(cardProvider(key));
}

/**
 * Collapse the server's 4-bucket `CardStatus` into the directory state machine.
 * The server already folds degraded/pending/unknown into `attention`; we
 * additionally force `degraded` when the connection's breaker is open so a
 * tripped breaker never reads as Connected. No fabricated health: an
 * unconfigured card stays `not_connected`.
 */
export function deriveDirectoryStatus(card: Pick<StatusCard, "status" | "meta">): DirectoryStatus {
  const breakerOpen = card.meta?.breakerOpen === true;
  switch (card.status) {
    case "connected":
      return breakerOpen ? "degraded" : "connected";
    case "attention":
      return "degraded";
    case "error":
      return "error";
    default:
      return "not_connected";
  }
}

/** Icon + text + tinted-pill metadata for each directory state. Never
 *  color-only — every state pairs an icon and a label (a11y AC). */
export const DIRECTORY_STATUS_META: Record<
  DirectoryStatus,
  { icon: IconName; label: string; fg: string; bg: string }
> = {
  connected: { icon: "check", label: "Connected", fg: "var(--green-600)", bg: "var(--green-50)" },
  degraded: { icon: "alert", label: "Degraded", fg: "var(--amberw-600)", bg: "var(--amberw-50)" },
  error: { icon: "alert", label: "Error", fg: "var(--red-600)", bg: "var(--red-50)" },
  not_connected: {
    icon: "dot",
    label: "Not connected",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
  },
};

/** Resolve the adapter capabilities a status card carries, falling back to the
 *  conservative default when `meta.capabilities` is absent or malformed. */
export function getCapabilities(card: Pick<StatusCard, "meta"> | undefined | null): IntegrationCapabilities {
  const raw = card?.meta?.capabilities;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CAPABILITIES };
  return { ...DEFAULT_CAPABILITIES, ...(raw as Partial<IntegrationCapabilities>) };
}

/** Keys whose values must never reach the DOM (ADR 0013). Matched
 *  case-insensitively against object keys when redacting free-form payloads. */
const SECRET_KEY_RE = /(api[-_]?key|api[-_]?token|secret|webhook[-_]?secret|password|authorization|token|bearer|credential)/i;

export const REDACTED = "[redacted]";

/**
 * Deep-clone `value`, replacing any object value whose KEY looks secret with
 * `[redacted]`. The integrations summaries are already secret-free by
 * construction; this guards the one free-form surface the UI renders — the
 * `payload`/`response` JSON of `integration_deliveries` rows — so a provider
 * that echoes a token into a webhook body cannot leak it into the DOM.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}
