// `/api/git/:host/<repository>.git/...` (REQ-73 BC-5): the door a relayed repository's git traffic
// takes. git's smart-HTTP requests (ref discovery, fetch and push) are passed to the host with the
// connection's own credential added here, and the host's answer streamed back, so a box clones,
// fetches and pushes while holding only the hour-long relay ticket its credential helper was handed
// (`integrations/source-host/git-relay.ts`). Every request decides again whether that box may still
// reach the repository. Hono's own proxy helper does the streaming; nothing is buffered.

import type { GitRefusalCode } from '@forge/contracts/git';
import { Hono } from 'hono';
import { proxy } from 'hono/proxy';
import { z } from 'zod';
import {
  GIT_RELAY_PREFIX,
  gitRelayRequestOf,
  readGitRelayTicket,
  relayedGitUpstream,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import { rawBody, zValidator } from '../middleware/zod-validator.js';

const refuse = refuser<GitRefusalCode>('GIT_REFUSED');

export const gitRelayRoutes = new Hono();

// a relayed body is git's own pack negotiation or pack, passed on as sent: declared, never parsed
const gitBody = rawBody(
  'application/x-git-upload-pack-request',
  "git's smart-HTTP request body (application/x-git-upload-pack-request or application/x-git-receive-pack-request), relayed to the host as sent; ref discovery carries none.",
  { required: false },
);

// ref discovery names the service it opens (`?service=git-upload-pack`); fetch and push carry none
const gitQuery = z.object({ service: z.string().max(40).optional() });

/** Request headers git's smart-HTTP client sends that the host reads; nothing else is passed on. */
const FORWARDED = ['content-type', 'accept', 'content-encoding', 'git-protocol', 'user-agent'];

/** The ticket out of git's Basic credential: whatever username, the password is the ticket. */
function ticketOf(authorization: string | undefined): string | null {
  const encoded = /^Basic\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (!encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  return at === -1 ? null : decoded.slice(at + 1) || null;
}

/**
 * git's own challenge: a 401 with `WWW-Authenticate` is what makes git ask its credential helper, so
 * a missing or expired ticket is answered this way rather than in the refusal envelope.
 */
function challenge(detail: string): Response {
  return new Response(JSON.stringify({ code: 'GIT_RELAY_UNAUTHENTICATED', detail }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Basic realm="Forge git relay", charset="UTF-8"',
    },
  });
}

gitRelayRoutes.on(
  ['GET', 'POST'],
  '/:host/:rest{.+}',
  zValidator('query', gitQuery),
  gitBody,
  async (c) => {
    const host = c.req.param('host').toLowerCase();
    const asked = gitRelayRequestOf(
      c.req.method,
      c.req.param('rest'),
      c.req.valid('query').service,
    );
    if (!asked) {
      throw refuse(
        'GIT_RELAY_PATH_UNKNOWN',
        `${c.req.method} /${GIT_RELAY_PREFIX}/${host}/${c.req.param('rest')} is not a git smart-HTTP request; the relay passes ref discovery (GET <repo>.git/info/refs?service=git-upload-pack|git-receive-pack) and fetch or push (POST <repo>.git/git-upload-pack|git-receive-pack) only`,
      );
    }
    const ticket = ticketOf(c.req.header('authorization'));
    const grant = ticket ? await readGitRelayTicket(ticket) : null;
    if (!grant) {
      return challenge(
        `${host}/${asked.repository} is reached through Forge with the relay ticket the runner's credential helper is handed (forge-runner git-credential); it is missing or expired, so git asks the helper again`,
      );
    }
    const upstream = await relayedGitUpstream(grant, host, asked.repository);
    if (!upstream) {
      throw refuse(
        'GIT_RELAY_FORBIDDEN',
        `${host}/${asked.repository} is no longer reachable from this device: the ticket's binding is gone, switched off, on a project this device no longer runs, or for another repository; nothing was relayed`,
      );
    }
    const headers = new Headers(upstream.headers);
    for (const name of FORWARDED) {
      const v = c.req.header(name);
      if (v) headers.set(name, v);
    }
    const search = asked.suffix === 'info/refs' ? `?service=${asked.service}` : '';
    const answer = await proxy(`${upstream.url}/${asked.suffix}${search}`, {
      raw: c.req.raw,
      headers,
    });
    logger.info(
      {
        deviceId: grant.deviceId,
        bindingId: grant.bindingId,
        repository: upstream.repository,
        service: asked.service,
        suffix: asked.suffix,
        status: answer.status,
      },
      'git-relay: relayed a git request',
    );
    if (answer.status === 401 || answer.status === 403) {
      await answer.body?.cancel();
      throw refuse(
        'GIT_RELAY_UPSTREAM_REFUSED',
        `${host} refused the connection's own credential for ${upstream.repository} (HTTP ${answer.status}) — its token is revoked, expired or lacks read_repository/write_repository; a project admin reconnects it on the project's Integrations page`,
      );
    }
    // the host's session cookie is its business with core, never the box's
    answer.headers.delete('set-cookie');
    return answer;
  },
);
