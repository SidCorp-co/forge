
import type { IntegrationCapabilities } from "@forge/contracts";
import type { IconName } from "@/design";
import { isDrillableProvider } from "./providers/registry";
import type { StatusCard } from "./types";

export type DirectoryStatus =
  | "connected"
  | "degraded"
  | "error"
  | "not_connected"
  | "needs_reauth"
  | "needs_scope"
  | "disabled"
  | "unverified";

/** The part of a declaration that survives the wire onto a status card. */
export type CardCapabilities = Omit<IntegrationCapabilities, "agentPath">;

/** Conservative default, so an absent `meta.capabilities` renders the most restrictive archetype
 *  (no delivery log, no stage split) rather than a fabricated one. */
export const DEFAULT_CAPABILITIES: CardCapabilities = {
  canDispatch: false,
  canReceiveWebhook: false,
  inboundUnprompted: false,
  canDeploy: false,
  liveConfirmGate: false,
  hasDeliveryLog: false,
  multiBinding: false,
  structuredRollback: false,
};

/** Card key → provider; a stage-suffixed key and a bare one map to the same provider. */
export function cardProvider(key: string): string {
  return key.split(":")[0] ?? key;
}

/** True when a status card represents a drillable connection provider. */
export function isProviderCard(key: string): boolean {
  return isDrillableProvider(cardProvider(key));
}

export interface ProviderCardGroup {
  provider: string;
  cards: StatusCard[];
}

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

export function deriveDirectoryStatus(card: Pick<StatusCard, "status" | "meta">): DirectoryStatus {
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
const SECRET_KEY_RE = /(api[-_]?key|api[-_]?token|private[-_]?key|service[-_]?account|secret|webhook[-_]?secret|password|authorization|token|bearer|credential)/i;

export const REDACTED = "[redacted]";

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
