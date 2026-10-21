import { STEWARD_NOTE_SUBJECT_KINDS, stewardNoteWriteSchema } from '@forge/contracts/steward';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readStewardNote, writeStewardNote } from './service.js';

const NOTE_PATH = '/:id/steward-notes/:subjectKind/:key';
const NOTE_SHAPE =
  '{ lines: [line 1, line 2?], cites: [{ kind, ref }], claims: { group, waitingKind, ref, stuck, stuckCode, dueAt }, basis, runId }';

const noteParam = z.strictObject({
  id: z.uuid(),
  subjectKind: z.enum(STEWARD_NOTE_SUBJECT_KINDS),
  key: z.string().trim().min(1).max(200),
});

export const stewardNoteRoutes = new Hono<{ Variables: AuthVars }>();
stewardNoteRoutes.use(NOTE_PATH, requireAuth(), assertEmailVerified());

const paramCheck = zValidator(
  'param',
  noteParam,
  invalid('invalid path: /api/projects/<project>/steward-notes/<requirement|feedback>/<key>'),
);

stewardNoteRoutes.get(NOTE_PATH, paramCheck, async (c) => {
  const { id, subjectKind, key } = c.req.valid('param');
  requireHeld(await loadProjectAccess(id, c.get('userId')), 'project.read');
  const { note } = await readStewardNote(id, subjectKind, key);
  return c.json({ note });
});

stewardNoteRoutes.put(
  NOTE_PATH,
  paramCheck,
  zValidator('json', stewardNoteWriteSchema, invalid(`invalid body: ${NOTE_SHAPE}`)),
  async (c) => {
    const { id, subjectKind, key } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.read');
    const note = await writeStewardNote({
      projectId: id,
      kind: subjectKind,
      key,
      write: c.req.valid('json'),
      userId,
      access,
    });
    return c.json({ note });
  },
);
