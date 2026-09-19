
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { providerLabel } from "./providers/registry";
import { type DirectoryStatus, deriveConnectionStatus } from "./derive";

/** Which of the header's two tallies a directory state counts toward, if either. */
export type GroupTally = "attention" | "off" | null;

export function tallyOf(status: DirectoryStatus): GroupTally {
  switch (status) {
    case "degraded":
    case "error":
    case "needs_reauth":
    case "needs_scope":
      return "attention";
    case "disabled":
      return "off";
    case "connected":
    case "unverified":
    case "not_connected":
      return null;
    default: {
      // Unreachable while the union is exhausted above; a value from outside it
      // could only come off the wire, and a tally is not the place to throw.
      const _exhaustive: never = status;
      void _exhaustive;
      return null;
    }
  }
}

/** One app's connections, with what a closed header has to state about them. */
export interface ConnectionGroup {
  /** The raw provider key, which is also the group's id. */
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
  return providerLabel(provider);
}

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

export function groupSummary(group: Pick<ConnectionGroup, "connections" | "needsAttention" | "off">): string {
  const count = group.connections.length;
  const parts = [`${count} connection${count === 1 ? "" : "s"}`];
  if (group.needsAttention > 0)
    parts.push(`${group.needsAttention} need${group.needsAttention === 1 ? "s" : ""} attention`);
  if (group.off > 0) parts.push(`${group.off} off`);
  return parts.join(" · ");
}
