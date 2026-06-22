import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertProjectAccess } from '../lib/authz.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { runMemoryWrite } from './write-service.js';
import {
  acceptCandidate,
  getCandidate,
  listGraduatedCandidates,
  rejectCandidate,
} from './candidates-service.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const listQuerySchema = paginationSchema.extend({ projectId: z.uuid() });
const idParamSchema = z.object({ id: z.uuid() });

export const memoryCandidatesRoutes = new Hono<{ Variables: AuthVars }>();
memoryCandidatesRoutes.use('*', requireAuth(), assertEmailVerified());

memoryCandidatesRoutes.get(
  '/candidates',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, limit, offset } = c.req.valid('query');
    const userId = c.get('userId');
    await assertProjectAccess(projectId, userId, 'viewer');

    const { items, totalCount } = await listGraduatedCandidates(projectId, limit, offset);
    setTotalCount(c, totalCount);
    return c.json(items);
  },
);

memoryCandidatesRoutes.post(
  '/candidates/:id/accept',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const candidate = await getCandidate(id);
    if (!candidate) throw new HTTPException(404, { message: 'Candidate not found' });
    await assertProjectAccess(candidate.projectId, userId);

    const result = await runMemoryWrite({
      projectId: candidate.projectId,
      source: 'knowledge',
      sourceRef: candidate.signalKey,
      textContent: candidate.summary,
      metadata: {
        signalType: candidate.signalType,
        evidenceCount: candidate.evidenceCount,
        evidence: candidate.evidence,
        candidateId: candidate.id,
      },
    });

    await acceptCandidate(id);
    return c.json(result, 200);
  },
);

memoryCandidatesRoutes.post(
  '/candidates/:id/reject',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const candidate = await getCandidate(id);
    if (!candidate) throw new HTTPException(404, { message: 'Candidate not found' });
    await assertProjectAccess(candidate.projectId, userId);

    await rejectCandidate(id);
    return c.json({ rejected: true }, 200);
  },
);
