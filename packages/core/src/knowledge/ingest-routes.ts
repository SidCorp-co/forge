import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { requireHeld } from '../permissions/index.js';
import { upsertKnowledgeEntries } from './service.js';

function toKebabSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^([^a-z0-9])/, 'k$1')
      .slice(0, 512) || 'knowledge'
  );
}

const MAX_DOCS_PER_REQUEST = 20;
const MAX_DOC_CONTENT_BYTES = 50 * 1024;
const RATE_LIMIT_PER_MIN = 100;

const documentSchema = z
  .object({
    id: z.string().min(1).max(500),
    title: z.string().min(1).max(500),
    content: z.string(),
    category: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ingestSchema = z
  .object({
    projectId: z.uuid(),
    documents: z.array(documentSchema).min(1).max(MAX_DOCS_PER_REQUEST),
  })
  .strict();

const badRequest = (message: string, details?: unknown) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST', details } });

export const knowledgeIngestRoutes = new Hono<{ Variables: AuthVars }>();
knowledgeIngestRoutes.use('*', requireAuth(), assertEmailVerified());

knowledgeIngestRoutes.post(
  '/ingest',
  zValidator('json', ingestSchema, (r) => {
    if (!r.success) throw badRequest('Invalid input', z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, documents } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    const limit = await consumeRateLimit(`ingest:${projectId}`, RATE_LIMIT_PER_MIN, 60_000);
    if (!limit.allowed) {
      throw new HTTPException(429, {
        message: 'Rate limit exceeded. Max 100 requests per minute.',
        cause: { code: 'RATE_LIMIT_EXCEEDED' },
      });
    }

    const skipped: Array<{ id: string; reason: string }> = [];
    const accepted: Array<{ id: string; input: Parameters<typeof upsertKnowledgeEntries>[0][0] }> =
      [];

    for (const doc of documents) {
      const contentBytes = Buffer.byteLength(doc.content, 'utf8');
      if (contentBytes > MAX_DOC_CONTENT_BYTES) {
        skipped.push({ id: doc.id, reason: 'content_exceeds_limit' });
        continue;
      }

      const text = `${doc.title}\n\n${doc.content}`.trim();
      if (!text) {
        skipped.push({ id: doc.id, reason: 'empty' });
        continue;
      }

      accepted.push({
        id: doc.id,
        input: {
          projectId,
          slug: toKebabSlug(doc.id),
          title: doc.title,
          body: text,
          kind: 'reference',
          injection: 'on_demand',
          confidence: 'inferred',
          authoredBy: 'imported',
          orderIndex: accepted.length,
          metadata: {
            sourceId: doc.id,
            category: doc.category ?? null,
            ...(doc.metadata ?? {}),
          },
        },
      });
    }

    let processed = 0;
    if (accepted.length > 0) {
      try {
        await upsertKnowledgeEntries(accepted.map((a) => a.input));
        processed = accepted.length;
      } catch (err) {
        logger.error(
          { err, docIds: accepted.map((a) => a.id), projectId },
          'knowledge.ingest: upsertKnowledgeEntries failed',
        );
        for (const a of accepted) skipped.push({ id: a.id, reason: 'index_failed' });
      }
    }
    const totalChunks = processed;

    return c.json({ ok: true, processed, totalChunks, skipped });
  },
);
