// What a route declares (ISS-824), for the routes of a module that sits below `permissions` (.arch.json
// context direction: credentials, api-contract, install) and so cannot import it: each is declared
// here and mounted in front of its router by route-registry.ts, as `app.use` or `app.on`.

import type { Hono } from 'hono';
import type { RequestIdVars } from './middleware/request-id.js';
import {
  requiresByRule,
  requiresInstanceAdmin,
  requiresNoPermission,
  requiresPublic,
  requiresSelf,
} from './permissions/index.js';

export const INSTALL_IS_PUBLIC = requiresPublic(
  'a box with no credential yet fetches the installer and the published runner build; nothing a project owns',
);

export const DISCOVERY_IS_PUBLIC = requiresPublic(
  'an MCP client with no token reads where to sign in; the documents name endpoints, never a row',
);
// an MCP client registers and trades its code with no sign-in (RFC 7591, RFC 6749 §4.1.3): the
// redirect and the PKCE verifier are the checks, held in the handler
const MCP_SIGN_IN_IS_PUBLIC = requiresPublic(
  'an MCP client with no token registers itself, or trades the code a signed-in person granted, or its refresh token; the registered client, its redirect and the PKCE verifier are the checks',
);
// outbox sits below permissions: its admin routes' declaration is mounted ahead of outboxAdminRoutes,
// after the admin routers whose credential gates already cover /api/admin/*
export const OUTBOX_IS_INSTANCE_ADMIN = requiresInstanceAdmin(
  "every project's dead deliveries, and those of project-less events, read and replayed by an operator of this instance",
);

export const CONTRACT_IS_PUBLIC = requiresPublic(
  'a published contract describes shapes and gates, never a row or a secret, and is read with no credential',
);

/** `POST /api/body/preview`, mounted ahead of `bodyRoutes`: body sits below permissions. */
export const BODY_PREVIEW_NEEDS_NO_PERMISSION = requiresNoPermission(
  'renders the text the caller sent as a stored body would be; it reads and writes no row',
);

/** The caller's own tokens and the MCP sign-in, mounted ahead of `patRoutes` and `mcpOauthRoutes`. */
export function declareCredentialRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.on(
    'GET',
    '/api/pat',
    requiresSelf('the caller’s own personal access tokens, listed by the caller'),
  );
  app.on(
    'DELETE',
    '/api/pat/:id',
    requiresSelf('the caller revokes a token of their own; another’s answers not found'),
  );
  // a token's or a grant's project list may name only projects the caller sees (FORBIDDEN_PROJECT)
  const visible = requiresByRule(
    'credentials/pat-grant-checks.ts:assertProjectsVisible',
    'the caller’s own token or grant, whose project list may name only projects the caller sees; refused naming the first it does not',
  );
  app.on('POST', '/api/pat', visible);
  app.on('PATCH', '/api/pat/:id', visible);
  app.on('POST', '/api/mcp-auth/authorize', visible);
  for (const path of ['/api/mcp-auth/register', '/api/mcp-auth/token']) {
    app.on('POST', path, MCP_SIGN_IN_IS_PUBLIC);
  }
  app.on(
    'GET',
    '/api/mcp-auth/authorize',
    requiresSelf(
      'the signed-in caller reads the consent screen for a grant that would be their own; it names the client and the menu, never another’s row',
    ),
  );
}
