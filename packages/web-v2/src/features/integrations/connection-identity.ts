
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

// In the reader's own time zone, as every time the web shows is (ISS-1229 r25).
const addedDay = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

const addedTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Each row's label, made longer by `more` only for the rows that still read like another one. */
function apart(
  rows: ReadonlyArray<{ id: string; createdAt: string }>,
  labels: Map<string, string>,
  more: (row: { createdAt: string }) => string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const label = labels.get(row.id) as string;
    const alike = rows.filter((o) => labels.get(o.id) === label).length > 1;
    const extra = alike ? more(row) : null;
    out.set(row.id, extra ? `${label}${extra}` : label);
  }
  return out;
}

type Labelled = {
  id: string;
  provider: string;
  displayName: string | null;
  config: Record<string, unknown>;
  createdAt: string;
};

/**
 * The one rule every list names a connection by: its name, else what it points at, else its
 * provider. Only where that is all there is are two alike told apart by when each was added: the
 * day, then the time on it. A number is left for two added in the same minute (ISS-1421 r6,
 * criterion 100). `withProvider` follows a name with its provider, for a list mixing providers;
 * the Connections page lists one app per section and shows the provider beside it (r8, 129).
 */
export function connectionLabels(
  connections: ReadonlyArray<Labelled>,
  withProvider: boolean,
): Map<string, string> {
  const base = new Map<string, string>();
  for (const c of connections) {
    const provider = providerLabel(c.provider);
    const name = connectionName(c) ?? connectionTarget(c);
    base.set(c.id, name ? (withProvider ? `${name} · ${provider}` : name) : provider);
  }
  const byOrder = [...connections].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const at = (c: { createdAt: string }) =>
    Number.isNaN(Date.parse(c.createdAt)) ? null : new Date(c.createdAt);
  const dated = apart(byOrder, base, (c) => {
    const when = at(c);
    return when ? ` · added ${addedDay(c.createdAt)}` : null;
  });
  const timed = apart(byOrder, dated, (c) => {
    const when = at(c);
    return when ? `, ${addedTime(c.createdAt)}` : null;
  });
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const c of byOrder) {
    const label = timed.get(c.id) as string;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    out.set(c.id, n === 1 ? label : `${label} (${n})`);
  }
  return out;
}

/** How the share picker lists each connection: the one rule, each name followed by its provider. */
export function connectionPickerLabels(connections: ReadonlyArray<Labelled>): Map<string, string> {
  return connectionLabels(connections, true);
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
