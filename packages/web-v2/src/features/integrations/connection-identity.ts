
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { connectionTargetFor, providerLabel } from "./providers/registry";

/** The name to show. Never invented: falls back to the provider, which is true — in `language` where given. */
export function connectionTitle(
  connection: {
    displayName: string | null;
    provider: string;
  },
  language?: string,
): string {
  return connection.displayName ?? providerLabel(connection.provider, language);
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
  language?: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    connectionTitle(connection),
    connectionTitle(connection, language),
    connection.provider,
    providerLabel(connection.provider),
    providerLabel(connection.provider, language),
    connectionTarget(connection) ?? "",
    ...connection.usage.bindings.map((b) => projectName(b.projectId)),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
