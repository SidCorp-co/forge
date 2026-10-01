import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { envelopeOf, refused } from '../project-config/respond.js';
import {
  listBuilderRunsAs,
  listLinksAs,
  readBuilderRunAs,
  readBus,
  readLinkAs,
  recordView,
} from './link-read.js';
import {
  createBuilderRun,
  createLink,
  type RecordOutcome,
  type RecordWriter,
  updateBuilderRun,
  updateLink,
} from './link-service.js';

export const linkProjectRoutes = new Hono<{ Variables: AuthVars }>();
export const busRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/links', '/:id/links/*', '/:id/builder-runs', '/:id/builder-runs/*']) {
  linkProjectRoutes.use(path, requireAuth(), assertEmailVerified());
}
busRoutes.use('/:id/bus', requireAuth(), assertEmailVerified());

const badRequest = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST' } });

const idParam = zValidator('param', z.object({ id: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the id is a uuid');
});

const linkParam = zValidator('param', z.object({ id: z.uuid(), link: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project and the link are uuids');
});

const runParam = zValidator('param', z.object({ id: z.uuid(), run: z.uuid() }), (r) => {
  if (!r.success) throw badRequest('invalid path: the project and the builder run are uuids');
});

const envelope = zValidator('json', z.unknown());

function writerOf(c: Context<{ Variables: AuthVars }>): RecordWriter {
  const agency = c.get('agency');
  if (!agency) throw new Error('ecosystem: a link write reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer<W extends object>(c: Context, outcome: RecordOutcome<W>) {
  if (!outcome.ok) return refused(c, outcome.refusals);
  const report = outcome.report ? { report: outcome.report } : {};
  return c.json({ ...recordView(outcome.held), created: outcome.created, ...report });
}

linkProjectRoutes.post('/:id/links', idParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const projectId = c.req.valid('param').id;
  return answer(
    c,
    await createLink({ projectId, writer: writerOf(c), baseRevision, raw: document }),
  );
});

linkProjectRoutes.get('/:id/links', idParam, async (c) => {
  const links = await listLinksAs(c.get('userId'), c.req.valid('param').id);
  return c.json({ links, returned: links.length });
});

linkProjectRoutes.get('/:id/links/:link', linkParam, async (c) => {
  const { id, link } = c.req.valid('param');
  return c.json(await readLinkAs(c.get('userId'), id, link));
});

linkProjectRoutes.put('/:id/links/:link', linkParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const { id, link } = c.req.valid('param');
  return answer(
    c,
    await updateLink({ projectId: id, id: link, writer: writerOf(c), baseRevision, raw: document }),
  );
});

linkProjectRoutes.post('/:id/builder-runs', idParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const projectId = c.req.valid('param').id;
  return answer(
    c,
    await createBuilderRun({ projectId, writer: writerOf(c), baseRevision, raw: document }),
  );
});

linkProjectRoutes.get('/:id/builder-runs', idParam, async (c) => {
  const runs = await listBuilderRunsAs(c.get('userId'), c.req.valid('param').id);
  return c.json({ runs, returned: runs.length });
});

linkProjectRoutes.get('/:id/builder-runs/:run', runParam, async (c) => {
  const { id, run } = c.req.valid('param');
  return c.json(await readBuilderRunAs(c.get('userId'), id, run));
});

linkProjectRoutes.put('/:id/builder-runs/:run', runParam, envelope, async (c) => {
  const { baseRevision, document } = envelopeOf(c.req.valid('json'));
  const { id, run } = c.req.valid('param');
  return answer(
    c,
    await updateBuilderRun({
      projectId: id,
      id: run,
      writer: writerOf(c),
      baseRevision,
      raw: document,
    }),
  );
});

busRoutes.get('/:id/bus', idParam, async (c) =>
  c.json(await readBus(c.get('userId'), c.req.valid('param').id)),
);
