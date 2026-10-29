const OPEN_QUERIES_FILE = 'packages/core/src/api-contract/open-queries.ts';

/**
 * The reads whose query stays open, each a priced amnesty (ISS-753). Every other GET closes its
 * query, so a key it does not take is refused by name; the contract generator refuses a GET that
 * neither closes its query nor is named here, and an entry naming a read that is closed or not
 * mounted. Each entry says what it trades and the condition that ends it, and the contract carries
 * the reason as `x-forge-query-open` on the operation.
 */
export type OpenQuery = {
  /** Why the keys this read is sent are not Forge's to name. */
  reason: string;
  /** What leaving it open costs. */
  trades: string;
  /** The condition that removes the entry. */
  endsWhen: string;
};

const THIRD_PARTY_REDIRECT = {
  trades:
    'a key the read does not take is dropped rather than refused; no person or Forge client composes this URL',
  endsWhen: 'the route is no longer a third-party redirect target',
} as const;

/** Keyed `METHOD /path` as the router mounts it, the name every generator refusal uses. */
export const OPEN_QUERY_READS: Readonly<Record<string, OpenQuery>> = {
  'GET /api/auth/oauth/:provider/callback': {
    reason:
      'the OAuth provider redirects here and chooses the keys it appends (scope, authuser, prompt, hd, …) beside code, state and error',
    ...THIRD_PARTY_REDIRECT,
  },
  'GET /api/integrations/github/installed': {
    reason:
      'GitHub redirects here after an app install and chooses the keys it appends (setup_action, …) beside installation_id, code and state',
    ...THIRD_PARTY_REDIRECT,
  },
  'GET /api/integrations/github/manifest-callback': {
    reason:
      'GitHub redirects here after an app manifest is created and chooses the keys it appends beside code and state',
    ...THIRD_PARTY_REDIRECT,
  },
  'GET /mcp': {
    reason:
      "the MCP transport answers 405 to every GET, telling an MCP client this server opens no stream; a client's configured server URL may carry a query, and a 400 there reads as a broken server rather than as no stream",
    trades:
      'a key on this GET is not refused by name; the answer is the same 405 with or without it, so no key is served as if absent',
    endsWhen: '/mcp serves a GET stream, which then declares the query it takes',
  },
};

// a read whose query is open answers a key it does not take as if it were absent (ISS-581 served
// revision 19 for `?revision=3`), so every GET closes its query or is a named amnesty
/** Why a read's operation is refused, or null; an allowlisted one is marked `x-forge-query-open`. */
export function queryClosure(
  operation: Record<string, unknown>,
  open: OpenQuery | undefined,
): string | null {
  const closed = operation['x-forge-query-closed'] === true;
  if (closed && open !== undefined) {
    return `an open-query amnesty in ${OPEN_QUERIES_FILE} for a read whose query is closed — remove the entry`;
  }
  if (!closed && open === undefined) {
    return (
      'a read whose query is not closed, so a key it does not take is served as if absent — hold ' +
      "noQuery, or zValidator('query', …) naming the keys it takes; a read whose keys a third " +
      `party chooses is named in ${OPEN_QUERIES_FILE} with what it trades and when that ends`
    );
  }
  if (open !== undefined) operation['x-forge-query-open'] = open.reason;
  return null;
}

/** Each allowlist entry naming a read no route mounts, so the list cannot outlive its routes. */
export function unmountedAmnesties(
  openQueries: Readonly<Record<string, OpenQuery>>,
  reads: ReadonlySet<string>,
): string[] {
  return Object.keys(openQueries)
    .sort()
    .filter((name) => !reads.has(name))
    .map(
      (name) =>
        `${name}: an open-query amnesty in ${OPEN_QUERIES_FILE} for a read no route mounts — remove the entry`,
    );
}
