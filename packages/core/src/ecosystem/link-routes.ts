import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { envelopeOf } from '../lib/write-envelope.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { supersedeBuilderRun } from './builder-supersede.js';
import {
  listBuilderRunsAs,
  listLinksAs,
  readBuilderRunAs,
  readBus,
  readLinkAs,
  recordView,
  writtenView,
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
busRoutes.use('/:id/builder-runs/*', requireAuth(), assertEmailVerified());

const idParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the id is a uuid'),
);

const linkParam = zValidator(
  'param',
  z.object({ id: z.uuid(), link: z.uuid() }),
  invalid('invalid path: the project and the link are uuids'),
);

const runParam = zValidator(
  'param',
  z.object({ id: z.uuid(), run: z.uuid() }),
  invalid('invalid path: the project and the builder run are uuids'),
);

const envelope = zValidator('json', z.unknown());

function writerOf(c: Context<{ Variables: AuthVars }>): RecordWriter {
  const agency = c.get('agency');
  if (!agency) throw new Error('ecosystem: a link write reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

function answer<W extends object>(c: Context, outcome: RecordOutcome<W>) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
  return c.json(writtenView(outcome));
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

const supersedeParam = zValidator(
  'param',
  z.object({ id: z.uuid(), run: z.uuid() }),
  invalid('invalid path: the ecosystem and the builder run are uuids'),
);

const supersedeBody = zValidator('json', z.unknown());

busRoutes.post('/:id/builder-runs/:run/supersede', supersedeParam, supersedeBody, async (c) => {
  const { id, run } = c.req.valid('param');
  const body = c.req.valid('json');
  const outcome = await supersedeBuilderRun({
    runId: run,
    ecosystemId: id,
    actor: writerOf(c),
    reason: body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined,
  });
  if (!outcome.ok) return refused(c, outcome.refusals, 'ECOSYSTEM_REFUSED');
  return c.json({ superseded: recordView(outcome.superseded), opened: recordView(outcome.opened) });
});
