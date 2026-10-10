// `/api/mcp-relay/:bindingId` (REQ-21 BC-2): the one door an agent's storefront MCP calls take. The
// relay ticket in its Authorization header is the credential, minted by core for this binding when
// the run's MCP config was resolved (`integrations/mcp-relay.ts`). Core adds the provider's own
// credential on the way out and streams the provider's answer back, so the agent never holds it.
// MCP's streamable HTTP transport: POST carries JSON-RPC, GET opens the server's stream, DELETE
// ends the session; each is passed through with the session headers the transport names.

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import { Hono } from 'hono';
import {
  readRelayTicket,
  relayedBinding,
  relayToUpstream,
  relayUpstreamOf,
} from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import { rawBody } from '../middleware/zod-validator.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

export const mcpRelayRoutes = new Hono();

// the relayed body is the agent's MCP message, passed on as sent: declared, never parsed here
const relayedMessage = rawBody(
  'application/json',
  'A JSON-RPC 2.0 message for the bound MCP server, relayed as sent; GET and DELETE carry none.',
  { required: false },
);

mcpRelayRoutes.on(['GET', 'POST', 'DELETE'], '/:bindingId', relayedMessage, async (c) => {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const grant = bearer ? await readRelayTicket(bearer) : null;
  if (!grant || grant.bindingId !== c.req.param('bindingId')) {
    throw refuse(
      'INTEGRATION_RELAY_FORBIDDEN',
      "this relay is opened only by the relay ticket Forge put in the run's MCP config for this binding; it is missing, expired or for another binding, so start a new run to be handed a fresh one",
      '/headers/authorization',
    );
  }
  const pair = await relayedBinding(grant);
  if (!pair) {
    throw refuse(
      'INTEGRATION_RELAY_FORBIDDEN',
      `binding ${grant.bindingId} is no longer this project's, active and granted to agents, so nothing is relayed; a project admin turns agent access on beside the integration under Settings → Integrations`,
    );
  }
  const upstream = await relayUpstreamOf(pair);
  if (!upstream) {
    throw refuse(
      'INTEGRATION_RELAY_NO_CREDENTIAL',
      `the ${pair.binding.provider} connection holds no usable credential (its health on Settings → Integrations names why), so nothing was sent`,
    );
  }
  const method = c.req.method;
  return relayToUpstream(upstream, {
    method,
    header: (name) => c.req.header(name),
    ...(method === 'POST' ? { body: await c.req.arrayBuffer() } : {}),
    signal: c.req.raw.signal,
  });
});
