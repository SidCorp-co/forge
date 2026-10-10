// The MCP relay (REQ-21 BC-2): an agent reaches a storefront's (or any HTTP MCP provider's) server
// through Forge, never with the provider credential. Its MCP config names a Forge URL and a relay
// ticket: an HS256 JWT core minted for ONE binding, under its own issuer so it verifies as nothing
// else. Core resolves the provider's endpoint and credential on every call, refreshing an expiring
// one, and the agent's environment never holds it.

import { jwtVerify, SignJWT } from 'jose';
import { env } from '../lib/env.js';
import { listAgentGrantedBindings } from './agent-access-store.js';
import { resolveApiBaseUrl } from './inbound-door.js';
import { getIntegration } from './registry.js';
import {
  type BindingWithConnection,
  decryptConnectionSecrets,
  effectiveConfig,
  findBindingWithConnectionById,
} from './store.js';

const ALG = 'HS256';
const ISSUER = 'forge.mcp.relay';
/** A run outlives a probe: the ticket lasts a working day; the credential behind it is resolved per call. */
export const MCP_RELAY_TICKET_SECONDS = 24 * 60 * 60;

let cachedKey: Uint8Array | null = null;
const key = (): Uint8Array => {
  cachedKey ??= new TextEncoder().encode(env.JWT_SECRET);
  return cachedKey;
};

export interface RelayGrant {
  projectId: string;
  bindingId: string;
}

export function signRelayTicket(grant: RelayGrant, now = Date.now()): Promise<string> {
  return new SignJWT({ pid: grant.projectId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(grant.bindingId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + MCP_RELAY_TICKET_SECONDS)
    .sign(key());
}

export async function readRelayTicket(token: string, now = Date.now()): Promise<RelayGrant | null> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      algorithms: [ALG],
      currentDate: new Date(now),
    });
    if (typeof payload.pid !== 'string' || typeof payload.sub !== 'string') return null;
    return { projectId: payload.pid, bindingId: payload.sub };
  } catch {
    return null;
  }
}

/** The provider's own MCP endpoint and the headers that open it, as its declaration renders them. */
export interface RelayUpstream {
  url: string;
  headers: Record<string, string>;
}

/**
 * What a binding's HTTP MCP entry is upstream: the endpoint and credential headers, resolved now
 * (refreshed where the provider's credential expires). Null where the binding has no usable
 * credential or its provider renders no HTTP entry, which the caller names.
 */
export async function relayUpstreamOf(pair: BindingWithConnection): Promise<RelayUpstream | null> {
  const decl = getIntegration(pair.binding.provider);
  const path = decl?.capabilities.agentPath;
  if (path?.kind !== 'direct-mcp' || !pair.connection.secretsEnc) return null;
  const stored = decryptConnectionSecrets<Record<string, unknown>>(pair.connection);
  if (!stored) return null;
  const config = effectiveConfig(pair);
  const secrets = path.freshSecrets
    ? await path.freshSecrets({ connectionId: pair.connection.id, config, secrets: stored })
    : stored;
  if (!secrets) return null;
  const entry = path.buildEntry(config, secrets);
  return httpUpstreamOf(entry);
}

export function httpUpstreamOf(entry: Record<string, unknown> | null): RelayUpstream | null {
  if (entry?.type !== 'http' || typeof entry.url !== 'string') return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((entry.headers ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') headers[k] = v;
  }
  return { url: entry.url, headers };
}

/** The Forge URL a binding's MCP calls are relayed through; null where core knows no public API origin. */
export function relayUrlFor(bindingId: string): string | null {
  const base = resolveApiBaseUrl();
  return base ? `${base}/api/mcp-relay/${bindingId}` : null;
}

/** The relay entry a run's MCP config carries in place of the provider's own: a Forge URL and a ticket. */
export async function relayEntryFor(grant: RelayGrant): Promise<Record<string, unknown> | null> {
  const url = relayUrlFor(grant.bindingId);
  if (!url) return null;
  return {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${await signRelayTicket(grant)}` },
    enabled: true,
  };
}

/** The binding a ticket names, while it is still this project's, active and granted to agents. */
export async function relayedBinding(grant: RelayGrant): Promise<BindingWithConnection | null> {
  const pair = await findBindingWithConnectionById(grant.bindingId);
  if (!pair || pair.binding.projectId !== grant.projectId) return null;
  const granted = await listAgentGrantedBindings(grant.projectId, pair.binding.provider);
  return granted.some((g) => g.binding.id === pair.binding.id) ? pair : null;
}

/** Request headers the MCP transport reads, passed upstream as sent. */
const FORWARDED = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];
/** Response headers the client reads, passed back as the provider sent them. */
const RETURNED = ['content-type', 'mcp-session-id', 'cache-control', 'www-authenticate'];

/** One MCP transport request as the relay door received it. */
export interface RelayedRequest {
  method: string;
  header: (name: string) => string | undefined;
  body?: ArrayBuffer;
  signal: AbortSignal;
}

/**
 * Sends one relayed request to the provider with its credential headers added, and streams the
 * provider's answer back carrying only the headers the client reads.
 */
export async function relayToUpstream(
  upstream: RelayUpstream,
  request: RelayedRequest,
): Promise<Response> {
  const headers = new Headers(upstream.headers);
  for (const name of FORWARDED) {
    const v = request.header(name);
    if (v) headers.set(name, v);
  }
  const answer = await fetch(upstream.url, {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body } : {}),
    signal: request.signal,
  });
  const out = new Headers();
  for (const name of RETURNED) {
    const v = answer.headers.get(name);
    if (v) out.set(name, v);
  }
  return new Response(answer.body, { status: answer.status, headers: out });
}
