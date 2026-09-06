// What tells one connection apart from another on the directory.
//
// Two credentials of the same provider are indistinguishable by provider
// alone, so a card is built from three things in order: the name its owner
// gave it, the target its config points at, and the projects using it. Pure,
// so the rules are testable without rendering.

import type { ConnectionDirectoryItem } from "@forge/contracts";
import { PROVIDER_LABEL } from "./components/status-pill";

function host(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function text(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The name to show. Never invented: falls back to the provider, which is true. */
export function connectionTitle(connection: {
  displayName: string | null;
  provider: string;
}): string {
  return (
    connection.displayName ?? PROVIDER_LABEL[connection.provider] ?? connection.provider
  );
}

// cm:guard the target is read from CONFIG, which is the non-secret tier — never widen these keys to reach a credential, because everything this returns is rendered into the DOM
/**
 * The endpoint or workspace this credential points at — the second thing that
 * distinguishes two connections of one provider. Null when the config carries
 * nothing identifying, so the card omits the line rather than showing a blank.
 */
export function connectionTarget(connection: {
  provider: string;
  config: Record<string, unknown>;
}): string | null {
  const config = connection.config ?? {};
  const owner = text(config, "owner");
  const repo = text(config, "repo");
  if (owner && repo) return `${owner}/${repo}`;
  return (
    host(config.baseUrl) ??
    host(config.endpoint) ??
    host(config.serverUrl) ??
    host(config.url) ??
    text(config, "workspaceName") ??
    text(config, "storeSlug") ??
    text(config, "org") ??
    text(config, "organization")
  );
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
    PROVIDER_LABEL[connection.provider] ?? "",
    connectionTarget(connection) ?? "",
    ...connection.usage.bindings.map((b) => projectName(b.projectId)),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
