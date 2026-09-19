
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { connectionTargetFor, providerLabel } from "./providers/registry";

/** The name to show. Never invented: falls back to the provider, which is true. */
export function connectionTitle(connection: {
  displayName: string | null;
  provider: string;
}): string {
  return connection.displayName ?? providerLabel(connection.provider);
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
