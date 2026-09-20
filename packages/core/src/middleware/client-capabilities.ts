/**
 * What a caller says it can do, so a rule can be enforced only where it can be obeyed.
 *
 * A refusal that lands before its callers can comply breaks them on a deploy
 * they did not ask for. The forge-plugin repo ships the `forge record` writer
 * on its own clock, and nothing here can gate that release; so the rule that
 * refuses a record serialised into a comment body is reachable only through a
 * token the caller volunteers. On the deploy that lands it, no client sends
 * this header, the declared set is empty on every request, and the refusal is
 * unreachable. The client turns it on for itself in the same release that
 * gives it somewhere else to write.
 *
 * Unknown tokens are ignored rather than refused: a newer client naming a
 * capability this build has never heard of is not a caller who broke the
 * contract, and the whole point of the header is that the two sides move
 * independently.
 */

import type { Context } from 'hono';

export const CLIENT_CAPABILITIES_HEADER = 'x-forge-capabilities';

/** The caller has a route to write a structured record to, so a fence is a bug. */
export const RECORD_ROUTE_CAPABILITY = 'record-route';

/** Every token this build gives meaning to. */
export const CLIENT_CAPABILITIES: readonly string[] = [RECORD_ROUTE_CAPABILITY];

export type ClientCapabilities = ReadonlySet<string>;

/** No capability at all — what every door that cannot read a header passes. */
export const NO_CAPABILITIES: ClientCapabilities = new Set<string>();

/**
 * The tokens a header value declares, comma or space separated, case-folded.
 */
export function parseClientCapabilities(raw: string | null | undefined): ClientCapabilities {
  if (!raw) return NO_CAPABILITIES;
  const declared = raw
    .split(/[\s,]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return declared.length > 0 ? new Set(declared) : NO_CAPABILITIES;
}

/** What this request declared, read off the header. */
// biome-ignore lint/suspicious/noExplicitAny: every door's Variables shape, read-only on the header
export function clientCapabilities(c: Context<any>): ClientCapabilities {
  return parseClientCapabilities(c.req.header(CLIENT_CAPABILITIES_HEADER));
}

/** Whether this request declared one named capability. */
export function declares(caps: ClientCapabilities, capability: string): boolean {
  return caps.has(capability);
}
