/**
 * What a caller says it can do, so a rule is enforced only where it can be obeyed: the
 * `record-in-comment` refusal is reachable only through a token the caller volunteers, and an
 * unrecognised token is ignored, because the two sides ship on their own clocks.
 */

import type { Context } from 'hono';

export const CLIENT_CAPABILITIES_HEADER = 'x-forge-capabilities';

export const RECORD_ROUTE_CAPABILITY = 'record-route';

export const CLIENT_CAPABILITIES: readonly string[] = [RECORD_ROUTE_CAPABILITY];

export type ClientCapabilities = ReadonlySet<string>;

export const NO_CAPABILITIES: ClientCapabilities = new Set<string>();

export function parseClientCapabilities(raw: string | null | undefined): ClientCapabilities {
  if (!raw) return NO_CAPABILITIES;
  const declared = raw
    .split(/[\s,]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return declared.length > 0 ? new Set(declared) : NO_CAPABILITIES;
}

// biome-ignore lint/suspicious/noExplicitAny: every door's Variables shape, read-only on the header
export function clientCapabilities(c: Context<any>): ClientCapabilities {
  return parseClientCapabilities(c.req.header(CLIENT_CAPABILITIES_HEADER));
}

export function declares(caps: ClientCapabilities, capability: string): boolean {
  return caps.has(capability);
}
