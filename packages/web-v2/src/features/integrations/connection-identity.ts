
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { connectionTargetFor, providerLabel } from "./providers/registry";

/** The name its owner gave it. A name stored before ISS-1421 opens with the provider's lower-case
 *  id ("coolify · …"), which every place it shows already says beside it, so that is dropped here,
 *  once, for every surface (ISS-1421 r6, criterion 101). */
export function connectionName(connection: {
  displayName: string | null;
  provider: string;
}): string | null {
  const prefix = `${connection.provider} · `;
  const name = connection.displayName?.startsWith(prefix)
    ? connection.displayName.slice(prefix.length)
    : connection.displayName;
  return name?.trim() ? name.trim() : null;
}

/** The name to show. Never invented: falls back to the provider, which is true. */
export function connectionTitle(connection: {
  displayName: string | null;
  provider: string;
}): string {
  return connectionName(connection) ?? providerLabel(connection.provider);
}

const ADDED_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * How a picker lists each connection: its name, else what it points at, then its provider. Two
 * still alike are told apart by the day each was added, and any alike after that by a number in
 * the order they were added, so no two rows read the same (ISS-1421 r6, criterion 100).
 */
export function connectionPickerLabels(
  connections: ReadonlyArray<{
    id: string;
    provider: string;
    displayName: string | null;
    config: Record<string, unknown>;
    createdAt: string;
  }>,
): Map<string, string> {
  const base = new Map<string, string>();
  for (const c of connections) {
    const provider = providerLabel(c.provider);
    const name = connectionName(c) ?? connectionTarget(c);
    base.set(c.id, name ? `${name} · ${provider}` : provider);
  }
  const byOrder = [...connections].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const dated = new Map<string, string>();
  for (const c of byOrder) {
    const label = base.get(c.id) as string;
    const alike = byOrder.filter((o) => base.get(o.id) === label).length > 1;
    const day = Number.isNaN(Date.parse(c.createdAt)) ? null : ADDED_DAY.format(new Date(c.createdAt));
    dated.set(c.id, alike && day ? `${label} · added ${day}` : label);
  }
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const c of byOrder) {
    const label = dated.get(c.id) as string;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    out.set(c.id, n === 1 ? label : `${label} (${n})`);
  }
  return out;
}

export function connectionTarget(connection: {
  provider: string;
  config: Record<string, unknown>;
}): string | null {
  return connectionTargetFor(connection.provider, connection.config);
}

/**
 * Free-text match across everything the card shows — including the names of
 * the projects using it, which is how an operator actually looks a credential
 * up ("which token does forge-dev deploy with").
 */
export function matchesQuery(
  connection: ConnectionDirectoryItem,
  query: string,
  projectName: (id: string) => string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    connectionTitle(connection),
    connection.provider,
    providerLabel(connection.provider),
    connectionTarget(connection) ?? "",
    ...connection.usage.bindings.map((b) => projectName(b.projectId)),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
