// The connections directory, grouped by the app a credential belongs to (ISS-1035).
//
// An org holding several credentials of one app — a Coolify token per
// environment, a service account held both org-wide and per project — reads as
// an undifferentiated wall when every connection is an equal card. The screen
// asks the operator to pick an APP first, so the header of a closed group has
// to carry enough to decide on: how many credentials are under it, how many
// want attention, and how many are switched off.
//
// Pure, like derive.ts beside it, so the counting rules are testable without
// rendering anything.

import type { ConnectionDirectoryItem } from "@forge/contracts";
import { PROVIDER_LABEL } from "./components/status-pill";
import { type DirectoryStatus, deriveConnectionStatus } from "./derive";

/** Which of the header's two tallies a directory state counts toward, if either. */
export type GroupTally = "attention" | "off" | null;

// cm:guard `unverified` counts toward NEITHER tally and `disabled` toward `off` alone — derive.ts calls unverified "no signal is not a live problem, just an unproven one", and a header counting it as attention sends the operator into a group where nothing is wrong
// cm:edge contract -> packages/web-v2/src/features/integrations/derive.ts — every DirectoryStatus this switch does not name falls to `null`, so a state added there is uncounted until it is named here
export function tallyOf(status: DirectoryStatus): GroupTally {
  switch (status) {
    case "degraded":
    case "error":
    case "needs_reauth":
    case "needs_scope":
      return "attention";
    case "disabled":
      return "off";
    default:
      return null;
  }
}

/** One app's connections, with what a closed header has to state about them. */
export interface ConnectionGroup {
  /** The raw provider key — `coolify`, `github` — which is also the group's id. */
  provider: string;
  /** What the operator calls the app. */
  label: string;
  connections: ConnectionDirectoryItem[];
  /** How many of `connections` are degraded, in error, or need re-auth or scope. */
  needsAttention: number;
  /** How many of `connections` are switched off. */
  off: number;
}

/** What to call an app on the directory; never invented — the key is true. */
export function appLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * One group per provider present in `items`, ordered by the label the operator
 * reads rather than by the order the API returned connections in, so the
 * directory does not reshuffle between loads. Connections keep their incoming
 * order within a group.
 */
export function groupConnectionsByApp(items: ConnectionDirectoryItem[]): ConnectionGroup[] {
  const byProvider = new Map<string, ConnectionGroup>();
  for (const connection of items) {
    let group = byProvider.get(connection.provider);
    if (!group) {
      group = {
        provider: connection.provider,
        label: appLabel(connection.provider),
        connections: [],
        needsAttention: 0,
        off: 0,
      };
      byProvider.set(connection.provider, group);
    }
    group.connections.push(connection);
    const tally = tallyOf(deriveConnectionStatus(connection));
    if (tally === "attention") group.needsAttention += 1;
    if (tally === "off") group.off += 1;
  }
  return [...byProvider.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.provider.localeCompare(b.provider),
  );
}

/**
 * The sentence under an app's name. A zero tally is omitted rather than
 * printed as "0 need attention" — a closed header is read at a glance, and a
 * row of zeroes is noise the operator has to parse before finding the number
 * that is not zero.
 */
export function groupSummary(group: Pick<ConnectionGroup, "connections" | "needsAttention" | "off">): string {
  const count = group.connections.length;
  const parts = [`${count} connection${count === 1 ? "" : "s"}`];
  if (group.needsAttention > 0) parts.push(`${group.needsAttention} need attention`);
  if (group.off > 0) parts.push(`${group.off} off`);
  return parts.join(" · ");
}
