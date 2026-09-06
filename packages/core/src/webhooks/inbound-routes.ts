import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { getAdapter } from '../integrations/registry.js';
import {
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../integrations/store.js';
import type { IntegrationProvider } from '../integrations/types.js';
import { logger } from '../logger.js';
import { verifyHmacSignature } from './hmac.js';

// cm:guard every header here belongs to a provider that actually SIGNS its webhooks — `x-coolify-signature-256` went with the Coolify inbound path (ISS-922) because Coolify sends no signature at all, and an entry for a provider that signs nothing only makes an unreachable branch look reachable.
const PROVIDER_SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-forge-signature-256'] as const;

const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });
const unauthorized = (code: string) =>
  new HTTPException(401, { message: 'invalid signature', cause: { code } });
const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

// Header → adapter provider lookup. Order matters only when a request
// carries multiple provider headers — first match wins.
const PROVIDER_HEADER_MAP: Array<{ header: string; provider: IntegrationProvider }> = [
  { header: 'x-github-event', provider: 'github' },
];

export const webhookInboundRoutes = new Hono();

webhookInboundRoutes.post('/in/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) throw badRequest({ slug: 'required' });

  // Raw body first — HMAC covers the untouched bytes.
  const rawBody = await c.req.raw.clone().text();

  const [project] = await db
    .select({ id: projects.id, secret: projects.webhookSecret })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!project) throw notFound();

  // cm:guard a provider header claims the request for its adapter and the generic path below never sees it — so registering an adapter is what MOVES a provider off `projects.webhookSecret` onto the binding's own `integrationSecret`. Adding a header here without an adapter turns every one of that provider's deliveries into ADAPTER_NOT_REGISTERED rather than falling through.
  for (const map of PROVIDER_HEADER_MAP) {
    if (!c.req.header(map.header)) continue;
    const adapter = getAdapter(map.provider);
    if (!adapter) throw badRequest({ provider: map.provider }, 'ADAPTER_NOT_REGISTERED');

    // cm:why multi-env disambiguation: the signature is verified against each binding's own integrationSecret and dispatched on the one that matches, which is what tells a staging delivery apart from a prod one.
    const candidatePairs = await listActiveBindingsForProjectProvider(project.id, map.provider);
    if (candidatePairs.length === 0) {
      throw badRequest({ provider: map.provider }, 'INTEGRATION_NOT_CONFIGURED');
    }

    const signatureHeader = PROVIDER_SIGNATURE_HEADERS.map((h) => c.req.header(h)).find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (!signatureHeader) {
      throw unauthorized('MISSING_SIGNATURE');
    }

    const pair = candidatePairs.find(
      (p) =>
        p.binding.integrationSecret !== null &&
        verifyHmacSignature(p.binding.integrationSecret, rawBody, signatureHeader),
    );
    if (!pair) {
      throw unauthorized('INVALID_SIGNATURE');
    }

    let parsed: unknown;
    try {
      parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      throw badRequest({ body: 'invalid json' });
    }
    const ctx = buildContextFromBinding(pair);
    try {
      const result = await adapter.handleInbound(ctx, {
        headers: collectHeaders(c.req.raw.headers),
        rawBody,
        payload: parsed,
      });
      return c.json({
        accepted: true,
        handler: map.provider,
        environment: pair.binding.environment,
        deliveryId: result.deliveryId,
        actions: result.actions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (/signature/i.test(message)) throw unauthorized('INVALID_SIGNATURE');
      logger.error(
        { err, slug, provider: map.provider, bindingId: pair.binding.id },
        'integration adapter: handler threw',
      );
      throw new HTTPException(500, {
        message: 'handler failed',
        cause: { code: 'HANDLER_FAILED' },
      });
    }
  }

  // cm:guard the generic path accepts a signed body and DOES NOTHING with it — keep it that way. It exists so a provider can be pointed here while its adapter is being written, and `actions: 0` in the response is the only thing telling an operator the payload was dropped. Anything that starts acting on a body here is a second inbound path, which is what registering an adapter is for.
  if (!project.secret) {
    throw badRequest({ slug: 'webhook not enabled' }, 'WEBHOOK_DISABLED');
  }

  const signatureHeader =
    c.req.header('x-hub-signature-256') ?? c.req.header('x-forge-signature-256') ?? null;
  if (!verifyHmacSignature(project.secret, rawBody, signatureHeader)) {
    throw unauthorized('INVALID_SIGNATURE');
  }

  try {
    if (rawBody.length > 0) JSON.parse(rawBody);
  } catch {
    throw badRequest({ body: 'invalid json' });
  }

  logger.info({ slug, bytes: rawBody.length }, 'webhook: generic receive');
  return c.json({ accepted: true, handler: 'generic', actions: 0 });
});

function collectHeaders(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}
