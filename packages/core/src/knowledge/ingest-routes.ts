import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { indexMemory } from '../memory/indexer.js';

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

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitEntry>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 5 * 60_000;

// Note: this limiter is in-memory and per-process. The deployment is
// single-process today (see CLAUDE.md "Current state"); behind a load
// balancer the effective limit becomes N × RATE_LIMIT_PER_MIN. Move into
// Postgres or a shared cache before scaling out.
function sweepExpired(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(key);
  }
}

export function checkRateLimit(key: string, limit = RATE_LIMIT_PER_MIN, now = Date.now()): boolean {
  sweepExpired(now);
  const entry = rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

export function resetRateLimits(): void {
  rateLimits.clear();
  lastSweep = Date.now();
}

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
    assertProjectRole(access, 'member');

    if (!checkRateLimit(`ingest:${projectId}`)) {
      throw new HTTPException(429, {
        message: 'Rate limit exceeded. Max 100 requests per minute.',
        cause: { code: 'RATE_LIMIT_EXCEEDED' },
      });
    }

    let processed = 0;
    let totalChunks = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

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

      try {
        await indexMemory({
          projectId,
          source: 'knowledge',
          sourceRef: doc.id,
          text,
          metadata: {
            title: doc.title,
            category: doc.category ?? null,
            ...(doc.metadata ?? {}),
          },
        });
        processed += 1;
        totalChunks += Math.max(1, Math.ceil(text.length / 500));
      } catch (err) {
        logger.error(
          { err, docId: doc.id, projectId },
          'knowledge.ingest: indexMemory failed',
        );
        skipped.push({ id: doc.id, reason: 'index_failed' });
      }
    }

    return c.json({ ok: true, processed, totalChunks, skipped });
  },
);
