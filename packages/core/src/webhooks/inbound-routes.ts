import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { getAdapter, listIntegrations } from '../integrations/registry.js';
import {
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../integrations/store.js';
import type { IntegrationProvider } from '../integrations/types.js';
import { logger } from '../logger.js';
import { verifyHmacSignature } from './hmac.js';

// cm:guard THE GENERIC PATH'S PAIR, and only it. A provider-routed delivery is verified against the ONE header its own declaration names (`capabilities.webhookSignatureHeader`), so nothing is added here when a provider is added — that is what ISS-1085 slice 4 finished moving out of this file, and this array is what was left of the map ISS-1071 derived from the declarations. Every header here still belongs to something that actually SIGNS: `x-coolify-signature-256` went with the Coolify inbound path (ISS-922) because Coolify sends no signature at all, and an entry for a provider that signs nothing only makes an unreachable branch look reachable.
const GENERIC_SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-forge-signature-256'] as const;

const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });
const unauthorized = (code: string) =>
  new HTTPException(401, { message: 'invalid signature', cause: { code } });
const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

/**
 * Header → provider lookup, DERIVED from the declarations rather than listed here.
 *
 * Order matters only when a request carries several provider headers — first match wins, which is
 * registry order. Until ISS-1071 this was a literal array in this file, and a provider that declared
 * a webhook without also being added to it was routed nowhere: the delivery answered 404 with the
 * integration reporting healthy, and nothing in the array's neighbourhood said a second edit was
 * owed.
 */
interface ProviderRoute {
  header: string;
  /** Absent only where a provider declares an inbound surface and forgets how it is signed. */
  signatureHeader: string | undefined;
  provider: IntegrationProvider;
}

function providerHeaderMap(): ProviderRoute[] {
  return listIntegrations()
    .filter((d) => d.capabilities.canReceiveWebhook && d.capabilities.webhookHeader)
    .map((d) => ({
      header: d.capabilities.webhookHeader as string,
      signatureHeader: d.capabilities.webhookSignatureHeader,
      provider: d.provider,
    }));
}

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
  for (const map of providerHeaderMap()) {
    if (!c.req.header(map.header)) continue;
    const adapter = getAdapter(map.provider);
    if (!adapter) throw badRequest({ provider: map.provider }, 'ADAPTER_NOT_REGISTERED');

    // cm:why multi-env disambiguation: the signature is verified against each binding's own integrationSecret and dispatched on the one that matches, which is what tells a staging delivery apart from a prod one.
    const candidatePairs = await listActiveBindingsForProjectProvider(project.id, map.provider);
    if (candidatePairs.length === 0) {
      throw badRequest({ provider: map.provider }, 'INTEGRATION_NOT_CONFIGURED');
    }

    // cm:guard a matched provider that declares NO signature header is refused by name, never dropped through to the generic path below. Falling through would verify a provider's delivery against `projects.webhookSecret` and answer it `actions: 0` — a 200 for a payload nobody handled, which is the silent substitution the declaration was moved here to end.
    if (!map.signatureHeader) {
      throw badRequest({ provider: map.provider }, 'PROVIDER_DECLARES_NO_SIGNATURE_HEADER');
    }
    // cm:guard ONE header, the one this provider declares — not whichever of a set happens to be present. A delivery that carried the right bytes under the wrong header name is a delivery from something that is not this provider, and accepting it on the strength of a verifying HMAC would mean the header name stopped identifying anything.
    const signatureHeader = c.req.header(map.signatureHeader);
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
        role: pair.binding.role,
        stages: pair.binding.stages,
        deliveryId: result.deliveryId,
        actions: result.actions,
        ...(result.refusal ? { refusal: result.refusal } : {}),
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
    GENERIC_SIGNATURE_HEADERS.map((h) => c.req.header(h)).find(
      (v): v is string => typeof v === 'string' && v.length > 0,
    ) ?? null;
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
