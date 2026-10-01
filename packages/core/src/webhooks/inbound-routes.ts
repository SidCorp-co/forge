import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { recordTurnedAwayInboundCall } from '../integrations/inbound-door.js';
import { getAdapter, listIntegrations } from '../integrations/registry.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveBindingsForProjectProvider,
} from '../integrations/store.js';
import type { IntegrationProvider } from '../integrations/types.js';
import { logger } from '../logger.js';
import { rawBody } from '../middleware/zod-validator.js';
import { badRequest, notFound } from '../projects/route-errors.js';
import { verifyHmacSignature } from './hmac.js';

const unauthorized = (code: string) =>
  new HTTPException(401, { message: 'invalid signature', cause: { code } });

/**
 * A call turned away at the door leaves a record on every binding it could have been meant for.
 *
 * ISS-1140: the refusals below are correct and, until this existed, invisible — nothing recorded
 * that a call had arrived at all, so "the provider never called" and "a call reached us and we
 * turned it away" read identically from inside Forge, and a wrong or rotated webhook secret was
 * unfalsifiable. The call is unauthenticated, which is what its signature failing MEANS, so it is
 * attributed to no sender and to no single binding: every active candidate gets the record and
 * the reading says the attribution is unknown.
 *
 * `INTEGRATION_NOT_CONFIGURED` and a slug that resolves to no project are deliberately NOT
 * recorded. There is no binding whose door they are, so there is nothing for the record to hang
 * on and nothing that would ever read it.
 *
 * Best-effort: a write that fails must never turn a 401 into a 500. The refusal is the
 * deliverable; the record is what makes it visible afterwards.
 */
async function noteTurnedAway(
  pairs: BindingWithConnection[],
  code: string,
  context: { slug: string; provider: string },
): Promise<void> {
  try {
    await Promise.all(
      pairs.map((pair) =>
        recordTurnedAwayInboundCall({
          bindingId: pair.binding.id,
          code,
          eventName: 'inbound.refused',
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, ...context }, 'integration inbound: recording the turn-away failed');
  }
}
/** A delivery naming no provider: the generic door verified it and then did nothing, so it is gone. */
function routeRemoved(): HTTPException {
  const headers = providerHeaderMap().map((m) => `${m.header} (${m.provider})`);
  return new HTTPException(410, {
    message: `POST /api/webhooks/in/:slug takes only a provider's webhook, and this request carries none of its headers: ${headers.join(', ')}. The generic delivery is removed — it was verified and then consumed by nothing. Bind the provider's integration to the project and point its webhook here.`,
    cause: { code: 'WEBHOOK_ROUTE_REMOVED', details: { providerHeaders: headers } },
  });
}

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

webhookInboundRoutes.post(
  '/in/:slug',
  rawBody(
    'application/json',
    "A provider's webhook payload, read as the exact bytes its signature header signs and parsed as JSON only after the signature verifies; an empty body is {}.",
  ),
  async (c) => {
    const slug = c.req.param('slug');
    if (!slug) throw badRequest({ slug: 'required' });

    if (!providerHeaderMap().some((m) => c.req.header(m.header))) throw routeRemoved();

    // Raw body first — HMAC covers the untouched bytes.
    const rawBody = await c.req.raw.clone().text();

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, slug))
      .limit(1);
    if (!project) throw notFound();

    for (const map of providerHeaderMap()) {
      if (!c.req.header(map.header)) continue;
      const adapter = getAdapter(map.provider);
      if (!adapter) throw badRequest({ provider: map.provider }, 'ADAPTER_NOT_REGISTERED');

      const candidatePairs = await listActiveBindingsForProjectProvider(project.id, map.provider);
      if (candidatePairs.length === 0) {
        throw badRequest({ provider: map.provider }, 'INTEGRATION_NOT_CONFIGURED');
      }

      if (!map.signatureHeader) {
        throw badRequest({ provider: map.provider }, 'PROVIDER_DECLARES_NO_SIGNATURE_HEADER');
      }
      const signatureHeader = c.req.header(map.signatureHeader);
      if (!signatureHeader) {
        await noteTurnedAway(candidatePairs, 'MISSING_SIGNATURE', { slug, provider: map.provider });
        throw unauthorized('MISSING_SIGNATURE');
      }

      const pair = candidatePairs.find(
        (p) =>
          p.binding.integrationSecret !== null &&
          verifyHmacSignature(p.binding.integrationSecret, rawBody, signatureHeader),
      );
      if (!pair) {
        await noteTurnedAway(candidatePairs, 'INVALID_SIGNATURE', { slug, provider: map.provider });
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
          deliveryId: result.deliveryId,
          actions: result.actions,
          ...(result.refusal ? { refusal: result.refusal } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        if (/signature/i.test(message)) {
          await noteTurnedAway([pair], 'INVALID_SIGNATURE', { slug, provider: map.provider });
          throw unauthorized('INVALID_SIGNATURE');
        }
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

    throw routeRemoved();
  },
);

function collectHeaders(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}
