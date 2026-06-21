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

/** Honest directory states. ISS-408/F3 added `needs_reauth`, surfaced from
 *  the raw `lastHealthStatus`. ISS-429 added two server-bucket states so the
 *  UI stops conflating distinct situations:
 *  - `disabled`   — the integration EXISTS but is switched off (previously
 *                   rendered "Not connected", indistinguishable from unset).
 *  - `unverified` — active but never health-checked (previously rendered
 *                   Degraded, which read as a live problem). */
export type DirectoryStatus =
  | "connected"
  | "degraded"
  | "error"
  | "not_connected"
  | "needs_reauth"
  | "disabled"
  | "unverified";

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
export const DRILLABLE_PROVIDERS = ["coolify", "postman", "epodsystem", "sentry"] as const;
export type DrillableProvider = (typeof DRILLABLE_PROVIDERS)[number];

/** Card key → provider; `coolify:staging` and `coolify` both map to `coolify`. */
export function cardProvider(key: string): string {
  return key.split(":")[0] ?? key;
}

/** True when a status card represents a drillable connection provider. */
export function isProviderCard(key: string): boolean {
  return (DRILLABLE_PROVIDERS as readonly string[]).includes(cardProvider(key));
}

/** A provider's status cards grouped under one entry. Single-card groups
 *  render as a normal card; multi-card groups (env-split providers like
 *  Coolify, which the backend keys `coolify:prod` / `coolify:staging`) render
 *  as one consolidated card with per-environment sub-rows. */
export interface ProviderCardGroup {
  provider: string;
  cards: StatusCard[];
}

/** Display order for environment sub-rows within a consolidated group —
 *  production before staging, deterministic regardless of backend row order. */
const ENV_SORT_ORDER: Record<string, number> = { prod: 0, staging: 1 };

function envRank(card: StatusCard): number {
  const env =
    (typeof card.meta?.environment === "string" ? card.meta.environment : undefined) ??
    card.key.split(":")[1] ??
    "";
  return ENV_SORT_ORDER[env] ?? 99;
}

/**
 * Group status cards by base provider (`cardProvider`), preserving the
 * first-seen order of providers. Within an env-split provider's group the
 * cards are sorted prod-then-staging so the rendered order is stable
 * regardless of the order the backend returned the bindings. Single-card
 * providers yield a group of length 1 and render exactly as before.
 */
export function groupCardsByProvider(cards: StatusCard[]): ProviderCardGroup[] {
  const groups: ProviderCardGroup[] = [];
  const byProvider = new Map<string, ProviderCardGroup>();
  for (const card of cards) {
    const provider = cardProvider(card.key);
    let group = byProvider.get(provider);
    if (!group) {
      group = { provider, cards: [] };
      byProvider.set(provider, group);
      groups.push(group);
    }
    group.cards.push(card);
  }
  for (const group of groups) {
    if (group.cards.length > 1) group.cards.sort((a, b) => envRank(a) - envRank(b));
  }
  return groups;
}

/**
 * Collapse the server's 4-bucket `CardStatus` into the directory state machine.
 * The server already folds degraded/pending/unknown into `attention`; we
 * additionally force `degraded` when the connection's breaker is open so a
 * tripped breaker never reads as Connected. No fabricated health: an
 * unconfigured card stays `not_connected`.
 */
export function deriveDirectoryStatus(card: Pick<StatusCard, "status" | "meta">): DirectoryStatus {
  // needs_reauth wins over breaker/bucket — F4 surfaces the credential-rejected
  // signal verbatim on `lastHealthStatus` (ISS-408/F3 + ISS-409/F4 contract).
  if (card.meta?.lastHealthStatus === "needs_reauth") return "needs_reauth";
  const breakerOpen = card.meta?.breakerOpen === true;
  switch (card.status) {
    case "connected":
      return breakerOpen ? "degraded" : "connected";
    case "attention":
      return "degraded";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
    case "unverified":
      // A tripped breaker is a live problem even before the first healthcheck.
      return breakerOpen ? "degraded" : "unverified";
    default:
      return "not_connected";
  }
}

/**
 * Directory state for an OWNER-SCOPED connection row (the workspace
 * connections directory, ISS-429) — the server's card bucketing applied
 * client-side, since connection summaries carry raw health fields rather than
 * a pre-bucketed status.
 */
export function deriveConnectionStatus(connection: {
  active: boolean;
  lastHealthStatus: string | null;
  breakerOpenedAt: string | null;
}): DirectoryStatus {
  if (!connection.active) return "disabled";
  if (connection.lastHealthStatus === "needs_reauth") return "needs_reauth";
  if (connection.breakerOpenedAt !== null) return "degraded";
  if (!connection.lastHealthStatus) return "unverified";
  const s = connection.lastHealthStatus.toLowerCase();
  if (s === "ok" || s === "healthy" || s === "success") return "connected";
  if (s === "degraded" || s === "pending" || s === "unknown") return "degraded";
  return "error";
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
  // ISS-408/F3 — distinct actionable state: the credential was rejected and
  // requires re-authorization. Lock icon (no `key` in the IconName union) +
  // amber-700 fg so it reads as actionable, not telemetry like Degraded.
  needs_reauth: {
    icon: "lock",
    label: "Needs re-auth",
    fg: "var(--amberw-700)",
    bg: "var(--amberw-50)",
  },
  // ISS-429 — exists but switched off; neutral like not_connected but the
  // label says the truth (there IS a configured integration here).
  disabled: {
    icon: "dot",
    label: "Disabled",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
  },
  // ISS-429 — active, never health-checked. Neutral, not amber: no signal is
  // not a live problem, just an unproven one.
  unverified: {
    icon: "dot",
    label: "Not verified",
    fg: "var(--fg-muted)",
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
