import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type AppDeliveryOutcome,
  findInstanceGithubApp,
  routeAppDelivery,
} from '../integrations/github/index.js';
import {
  type BindingWithConnection,
  bindingInboundSecret,
  buildContextFromBinding,
  dropPreviousHeldInboundSecret,
  getAdapter,
  heldInboundSecret,
  type IntegrationConnectionRow,
  type IntegrationProvider,
  listActiveBindingsForProjectProvider,
  listBindingsForConnection,
  listIntegrations,
  previousHeldInboundSecret,
  recordTurnedAwayInboundCall,
} from '../integrations/index.js';
import { verifyHmacSignature, verifySharedToken } from '../lib/hmac.js';
import { logger } from '../lib/logger.js';
import { isRefusal, type RefusalError, refuser } from '../lib/refusal.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { rawBody } from '../middleware/zod-validator.js';
import { emitEvents } from '../outbox/index.js';
import { findProjectIdBySlug } from '../projects/index.js';

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
const refuseInbound = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

/** A delivery naming no provider: the generic door verified it and then did nothing, so it is gone. */
function routeRemoved(): RefusalError {
  const headers = providerHeaderMap().map((m) => `${m.header} (${m.provider})`);
  return refuseInbound(
    'WEBHOOK_ROUTE_REMOVED',
    `POST /api/webhooks/in/:slug takes only a provider's webhook, and this request carries none of its headers: ${headers.join(', ')}. The generic delivery is removed — it was verified and then consumed by nothing. Bind the provider's integration to the project and point its webhook here.`,
  );
}

interface ProviderRoute {
  header: string;
  /** Absent only where a provider declares an inbound surface and forgets how it is signed. */
  signatureHeader: string | undefined;
  verification: 'hmac-sha256' | 'shared-token';
  provider: IntegrationProvider;
}

// derived from the integration declarations, never listed here: a hand-kept list let a provider that declared a webhook route nowhere while it reported healthy (ISS-1071). A request carrying several provider headers takes the first in registry order.
function providerHeaderMap(): ProviderRoute[] {
  return listIntegrations()
    .filter((d) => d.capabilities.canReceiveWebhook && d.capabilities.webhookHeader)
    .map((d) => ({
      header: d.capabilities.webhookHeader as string,
      signatureHeader: d.capabilities.webhookSignatureHeader,
      verification: d.capabilities.webhookVerification ?? 'hmac-sha256',
      provider: d.provider,
    }));
}

export const webhookInboundRoutes = new Hono();

/** What a routed App delivery answers: 200 with what became of it, 500 when a handler threw. */
async function answerAppDelivery(
  c: Context,
  connection: IntegrationConnectionRow,
  raw: string,
  payload: unknown,
): Promise<Response> {
  const outcome: AppDeliveryOutcome = await routeAppDelivery({
    connection,
    input: {
      headers: Object.fromEntries(c.req.raw.headers),
      rawBody: raw,
      payload,
      emitFacts: emitEvents,
    },
  });
  if (outcome.kind === 'routed' && outcome.failed > 0) {
    throw new HTTPException(500, { message: 'handler failed', cause: { code: 'HANDLER_FAILED' } });
  }
  return c.json({ accepted: true, handler: 'github', ...outcome });
}

const GITHUB_SIGNATURE = 'x-hub-signature-256';

/**
 * The instance App's own door: every installation's deliveries arrive here, signed with the App's
 * one webhook secret. A delivery that does not verify against it is refused before anything routes,
 * and leaves its record on the App's live bindings, as a project's door does.
 */
webhookInboundRoutes.post(
  '/github/app',
  rawBody(
    'application/json',
    "The instance GitHub App's webhook payload, read as the exact bytes x-hub-signature-256 signs and parsed as JSON only after it verifies.",
  ),
  async (c) => {
    const app = await findInstanceGithubApp();
    if (!app) {
      throw new HTTPException(404, {
        message:
          'this Forge has no GitHub App of its own, so nothing here receives an App-wide delivery: a Forge operator connects GitHub first.',
        cause: { code: 'GITHUB_APP_NOT_CONNECTED' },
      });
    }
    const raw = await c.req.raw.clone().text();
    const live = async () =>
      (await listBindingsForConnection(app.id)).filter(
        (pair) => pair.binding.active && pair.binding.provider === 'github',
      );
    const signature = c.req.header(GITHUB_SIGNATURE);
    if (!signature) {
      await noteTurnedAway(await live(), 'MISSING_SIGNATURE', {
        slug: '(app)',
        provider: 'github',
      });
      throw unauthorized('MISSING_SIGNATURE');
    }
    const verifies = (secret: string | null) =>
      secret !== null && secret.length > 0 && verifyHmacSignature(secret, raw, signature);
    if (verifies(heldInboundSecret(app))) {
      if (previousHeldInboundSecret(app)) await dropPreviousHeldInboundSecret(app.id);
    } else if (!verifies(previousHeldInboundSecret(app))) {
      await noteTurnedAway(await live(), 'INVALID_SIGNATURE', {
        slug: '(app)',
        provider: 'github',
      });
      throw unauthorized('INVALID_SIGNATURE');
    }
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      throw badRequest({ body: 'invalid json' });
    }
    return answerAppDelivery(c, app, raw, parsed);
  },
);

webhookInboundRoutes.post(
  '/in/:slug',
  rawBody(
    'application/json',
    "A provider's webhook payload, read as the exact bytes its signature header signs and parsed as JSON only after the signature verifies; an empty body is {}.",
  ),
  async (c) => {
    const slug = c.req.param('slug');
    if (!slug) throw badRequest({ slug: 'required' });

    const map = providerHeaderMap().find((m) => c.req.header(m.header));
    if (!map) throw routeRemoved();

    // Raw body first — HMAC covers the untouched bytes.
    const raw = await c.req.raw.clone().text();

    const projectId = await findProjectIdBySlug(slug);
    if (!projectId) throw notFound();

    const adapter = getAdapter(map.provider);
    if (!adapter) throw badRequest({ provider: map.provider }, 'ADAPTER_NOT_REGISTERED');

    const candidatePairs = await listActiveBindingsForProjectProvider(projectId, map.provider);
    if (candidatePairs.length === 0) {
      throw badRequest({ provider: map.provider }, 'INTEGRATION_NOT_CONFIGURED');
    }

    if (!map.signatureHeader) {
      throw badRequest({ provider: map.provider }, 'PROVIDER_DECLARES_NO_SIGNATURE_HEADER');
    }
    const shared = map.verification === 'shared-token';
    const signatureHeader = c.req.header(map.signatureHeader);
    if (!signatureHeader) {
      const code = shared ? 'MISSING_WEBHOOK_TOKEN' : 'MISSING_SIGNATURE';
      await noteTurnedAway(candidatePairs, code, { slug, provider: map.provider });
      throw unauthorized(code);
    }

    const verifies = (secret: string | null) =>
      secret !== null &&
      (shared
        ? verifySharedToken(secret, signatureHeader)
        : verifyHmacSignature(secret, raw, signatureHeader));
    // A rotated provider-held secret: the replaced one verifies until the new one first does.
    let pair = candidatePairs.find((p) => verifies(bindingInboundSecret(p.binding)));
    if (pair && previousHeldInboundSecret(pair.connection)) {
      await dropPreviousHeldInboundSecret(pair.connection.id);
    }
    pair ??= candidatePairs.find((p) => verifies(previousHeldInboundSecret(p.connection)));
    if (!pair) {
      const code = shared ? 'WEBHOOK_TOKEN_MISMATCH' : 'INVALID_SIGNATURE';
      await noteTurnedAway(candidatePairs, code, { slug, provider: map.provider });
      throw unauthorized(code);
    }

    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      throw badRequest({ body: 'invalid json' });
    }
    // the instance's App serves every project, so what its delivery names picks the bindings, not
    // the slug its hook happens to point at
    if (pair.connection.ownerType === 'instance' && map.provider === 'github') {
      return answerAppDelivery(c, pair.connection, raw, parsed);
    }
    const ctx = buildContextFromBinding(pair);
    try {
      const result = await adapter.handleInbound(ctx, {
        headers: Object.fromEntries(c.req.raw.headers),
        rawBody: raw,
        payload: parsed,
        // The adapter performs no effect on Forge's modules: what the delivery reports goes to the
        // outbox in the transaction that settles the delivery, and the module owning each effect
        // consumes it.
        emitFacts: emitEvents,
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
      if (err instanceof HTTPException) throw err;
      if (isRefusal(err)) {
        logger.warn(
          { slug, provider: map.provider, bindingId: pair.binding.id, refusal: err.message },
          'integration adapter: delivery refused',
        );
        throw err;
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
  },
);
