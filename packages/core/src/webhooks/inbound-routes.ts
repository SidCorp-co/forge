import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectIntegrations, projects } from '../db/schema.js';
import { buildContext } from '../integrations/store.js';
import { getAdapter } from '../integrations/registry.js';
import type { IntegrationProvider } from '../integrations/types.js';
import { logger } from '../logger.js';
import { handleGitHubEvent } from './github-adapter.js';
import { verifyHmacSignature } from './hmac.js';

const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });
const unauthorized = (code: string) =>
  new HTTPException(401, { message: 'invalid signature', cause: { code } });
const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

// Header → adapter provider lookup. Order matters only when a request
// carries multiple provider headers — first match wins.
const PROVIDER_HEADER_MAP: Array<{ header: string; provider: IntegrationProvider }> = [
  { header: 'x-coolify-event', provider: 'coolify' },
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

  // Adapter dispatch happens BEFORE the legacy GitHub path so registered
  // providers get their scoped integrationSecret (not projects.webhookSecret).
  // Only triggers when a provider header is present, so the legacy
  // GitHub/generic test cases are untouched.
  for (const map of PROVIDER_HEADER_MAP) {
    if (!c.req.header(map.header)) continue;
    const adapter = getAdapter(map.provider);
    if (!adapter) throw badRequest({ provider: map.provider }, 'ADAPTER_NOT_REGISTERED');

    const integrationRow = await findActiveIntegration(project.id, map.provider);
    if (!integrationRow) {
      throw badRequest({ provider: map.provider }, 'INTEGRATION_NOT_CONFIGURED');
    }
    if (!integrationRow.integrationSecret) {
      throw badRequest({ provider: map.provider }, 'INTEGRATION_SECRET_MISSING');
    }
    let parsed: unknown;
    try {
      parsed = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      throw badRequest({ body: 'invalid json' });
    }
    const ctx = buildContext(integrationRow);
    try {
      const result = await adapter.handleInbound(ctx, {
        headers: collectHeaders(c.req.raw.headers),
        rawBody,
        payload: parsed,
      });
      return c.json({
        accepted: true,
        handler: map.provider,
        deliveryId: result.deliveryId,
        actions: result.actions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (/signature/i.test(message)) throw unauthorized('INVALID_SIGNATURE');
      logger.error(
        { err, slug, provider: map.provider },
        'integration adapter: handler threw',
      );
      throw new HTTPException(500, {
        message: 'handler failed',
        cause: { code: 'HANDLER_FAILED' },
      });
    }
  }

  // Legacy GitHub + generic path, preserved verbatim so the existing
  // inbound-routes.test.ts regression test continues to pass.
  if (!project.secret) {
    throw badRequest({ slug: 'webhook not enabled' }, 'WEBHOOK_DISABLED');
  }

  const signatureHeader =
    c.req.header('x-hub-signature-256') ?? c.req.header('x-forge-signature-256') ?? null;
  if (!verifyHmacSignature(project.secret, rawBody, signatureHeader)) {
    throw unauthorized('INVALID_SIGNATURE');
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    throw badRequest({ body: 'invalid json' });
  }

  const githubEvent = c.req.header('x-github-event');
  if (githubEvent) {
    try {
      const result = await handleGitHubEvent(
        project.id,
        githubEvent,
        payload as Parameters<typeof handleGitHubEvent>[2],
      );
      return c.json({ accepted: true, handler: 'github', actions: result.actions });
    } catch (err) {
      logger.error({ err, slug, event: githubEvent }, 'github-adapter: handler threw');
      throw new HTTPException(500, {
        message: 'handler failed',
        cause: { code: 'HANDLER_FAILED' },
      });
    }
  }

  logger.info({ slug, bytes: rawBody.length }, 'webhook: generic receive');
  return c.json({ accepted: true, handler: 'generic', actions: 0 });
});

async function findActiveIntegration(projectId: string, provider: IntegrationProvider) {
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, provider),
        eq(projectIntegrations.active, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function collectHeaders(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}
