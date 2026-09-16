// What tells one connection apart from another on the directory.
//
// Two credentials of the same provider are indistinguishable by provider
// alone, so a card is built from three things in order: the name its owner
// gave it, the target its config points at, and the projects using it. Pure,
// so the rules are testable without rendering.

import type { ConnectionDirectoryItem } from "@forge/contracts";
import { connectionTargetFor, providerLabel } from "./providers/registry";

/** The name to show. Never invented: falls back to the provider, which is true. */
export function connectionTitle(connection: {
  displayName: string | null;
  provider: string;
}): string {
  return connection.displayName ?? providerLabel(connection.provider);
}

/**
 * The endpoint or workspace this credential points at — the second thing that
 * distinguishes two connections of one provider. Null when the config carries
 * nothing identifying, so the card omits the line rather than showing a blank.
 *
 * Each provider says how to read its own, on its module. The key list this replaced was one
 * union of every provider's config keys, so a provider whose identifying key was not in it — Sentry's
 * `host`, Google's `clientEmail` — silently had no target line at all.
 */
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
