// web-v2 integrations directory — pure view-model helpers (ISS-402).
//
// Side-effect-free so they unit-test under the existing pure-vitest setup
// (web-v2 has no jsdom/RTL). The directory cards + connection-detail drawer
// derive their state from the composed status read model
// (`GET /:projectId/integrations/status`) and the adapter `capabilities` it
// carries — never from fabricated health.

import type { IntegrationCapabilities } from "@forge/contracts";
import type { IconName } from "@/design";
import { isDrillableProvider } from "./providers/registry";
import type { StatusCard } from "./types";

/** Honest directory states. ISS-408/F3 added `needs_reauth`, surfaced from
 *  the raw `lastHealthStatus`. ISS-429 added two server-bucket states so the
 *  UI stops conflating distinct situations:
 *  - `disabled`   — the integration EXISTS but is switched off (previously
 *                   rendered "Not connected", indistinguishable from unset).
 *  - `unverified` — active but never health-checked (previously rendered
 *                   Degraded, which read as a live problem).
 *  ISS-924 added `needs_scope` — the provider RECOGNISES the credential and
 *  refuses the route it was used on. Re-entering the same credential reproduces
 *  it exactly, so it must not render as `needs_reauth`. */
export type DirectoryStatus =
  | "connected"
  | "degraded"
  | "error"
  | "not_connected"
  | "needs_reauth"
  | "needs_scope"
  | "disabled"
  | "unverified";

// cm:guard `agentPath` is the one declared capability this type drops, and it is dropped because it
// CANNOT arrive: its `direct-mcp` arm carries a `buildEntry` function, so what reaches a card's
// `meta.capabilities` over JSON is the scalar half and nothing else. A screen asking how an agent
// reaches a provider reads `BindingSummary.agentPathKind`, which the server projects for exactly
// this reason, or the provider's own module in the connect flow.
/** The part of a declaration that survives the wire onto a status card. */
export type CardCapabilities = Omit<IntegrationCapabilities, "agentPath">;

/** Conservative default, so an absent `meta.capabilities` renders the most restrictive archetype
 *  (no delivery log, no stage split) rather than a fabricated one. */
export const DEFAULT_CAPABILITIES: CardCapabilities = {
  canDispatch: false,
  canReceiveWebhook: false,
  canDeploy: false,
  liveConfirmGate: false,
  hasDeliveryLog: false,
  multiBinding: false,
};

/** Card key → provider; a stage-suffixed key and a bare one map to the same provider. */
export function cardProvider(key: string): string {
  return key.split(":")[0] ?? key;
}

/** True when a status card represents a drillable connection provider. */
export function isProviderCard(key: string): boolean {
  return isDrillableProvider(cardProvider(key));
}

/** A provider's status cards grouped under one entry. Single-card groups
 *  render as a normal card; multi-card groups (a stage-split provider, whose
 *  cards the backend keys `<provider>:live` / `<provider>:preview`) render
 *  as one consolidated card with per-stage sub-rows. */
export interface ProviderCardGroup {
  provider: string;
  cards: StatusCard[];
}

/**
 * Display order for the sub-rows within a consolidated group: what real users
 * are on first, then what they are shown before it counts, then the facilities
 * that serve neither.
 *
 * Read off `meta.role` / `meta.stages`, which is what the server now sends
 * (`status-service.ts:buildProviderCards`), with the key suffix as the fallback
 * for a card built before those were carried. The predecessor of this function
 * ranked on `{ prod: 0, staging: 1 }` against `meta.environment` — a field
 * ISS-1046 removed — so after the rename every card ranked 99 and the sort this
 * exists for silently stopped ordering anything. A rank that ties for every
 * input is indistinguishable from a correct one in the rendered output, which is
 * why the case below asserts the ORDER and not merely the membership.
 */
function stageRank(card: StatusCard): number {
  const role = typeof card.meta?.role === "string" ? card.meta.role : undefined;
  const stages = Array.isArray(card.meta?.stages)
    ? (card.meta.stages as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  const suffix = card.key.split(":")[1] ?? "";
  if (role === "service" || suffix === "service") return 2;
  const live = stages ? stages.includes("live") : suffix.includes("live");
  return live ? 0 : 1;
}

/**
 * Group status cards by base provider (`cardProvider`), preserving the
 * first-seen order of providers. Within a stage-split provider's group the
 * cards are sorted live-then-preview-then-service so the rendered order is
 * stable regardless of the order the backend returned the bindings. Single-card
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
    if (group.cards.length > 1) group.cards.sort((a, b) => stageRank(a) - stageRank(b));
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
  // cm:guard both credential states are read from the RAW lastHealthStatus and win over the server bucket and the breaker — the bucket collapses them to `attention` and cannot be un-collapsed here, and they name two different operator actions (ISS-408/F3, ISS-409/F4, ISS-924)
  if (card.meta?.lastHealthStatus === "needs_reauth") return "needs_reauth";
  if (card.meta?.lastHealthStatus === "needs_scope") return "needs_scope";
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
  if (connection.lastHealthStatus === "needs_scope") return "needs_scope";
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
  // cm:guard needs_scope must never share needs_reauth's label — one says replace the credential, the other says the credential is fine and its permissions are not, and an operator who reads the wrong one does work that reproduces the state exactly (ISS-924)
  // cm:guard the label says PERMISSION and not "scope", and it is shared by three providers whose remedies are not the same page: Coolify wants a token ability, GitHub an App permission, and Google the spreadsheet shared with the service account. "Needs wider scope" sent a Google operator hunting an OAuth setting that does not exist for them (ISS-1036). The precise sentence belongs on the provider's own panel, which is the only place that knows which of the three this is.
  needs_scope: {
    icon: "lock",
    label: "Permission needed",
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
export function getCapabilities(
  card: Pick<StatusCard, "meta"> | undefined | null,
): CardCapabilities {
  const raw = card?.meta?.capabilities;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CAPABILITIES };
  return { ...DEFAULT_CAPABILITIES, ...(raw as Partial<CardCapabilities>) };
}

/** Keys whose values must never reach the DOM (ADR 0013). Matched
 *  case-insensitively against object keys when redacting free-form payloads. */
// cm:guard `private[-_]?key` and `service[-_]?account` are NOT covered by the `token`/`secret` alternatives beside them — a GitHub App PEM and a Google service-account key file carry neither word, so before ISS-1036 either would have rendered into the DOM verbatim. Adding a credential shape to the vault means adding its key name here.
const SECRET_KEY_RE = /(api[-_]?key|api[-_]?token|private[-_]?key|service[-_]?account|secret|webhook[-_]?secret|password|authorization|token|bearer|credential)/i;

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
