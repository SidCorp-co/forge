import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { handleGitHubEvent } from './github-adapter.js';
import { verifyHmacSignature } from './hmac.js';

const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });
const unauthorized = (code: string) =>
  new HTTPException(401, { message: 'invalid signature', cause: { code } });
const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

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
