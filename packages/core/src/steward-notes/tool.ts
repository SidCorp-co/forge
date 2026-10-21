// The steward note door for an agent (REQ-48 BC-7): the same function the route calls, so a note
// written from a turn passes the one vet a person's override passes.

import { STEWARD_NOTE_SUBJECT_KINDS, stewardNoteWriteSchema } from '@forge/contracts/steward';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { requireHeld } from '../permissions/index.js';
import { readStewardNote, writeStewardNote } from './service.js';

const input = z.strictObject({
  projectId: z.uuid(),
  action: z.enum(['get', 'write']),
  subjectKind: z.enum(STEWARD_NOTE_SUBJECT_KINDS),
  key: z.string().trim().min(1).max(200),
  note: stewardNoteWriteSchema.optional(),
});

export const forgeStewardNoteTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_steward_note',
  reach: 'project',
  route: '/api/projects',
  grant: { byAction: { get: 'projects:read', write: 'projects:write' } },
  description:
    'Read or write the two-line steward note on a requirement or feedback item. `get` answers the current note (stale where the standing moved since) and the standing it is checked against. `write` takes `note`: line 1 what happened and what blocks, line 2 what is next and by when (each at most 160 characters), 1 to 8 cites, `claims` copied from the standing (group, waitingKind, ref, stuck, stuckCode, dueAt) and its `basis`. A claim that disagrees with the standing is refused naming the field; a moved standing is refused STEWARD_NOTE_STALE with the new basis.',
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const { projectId, action, subjectKind, key, note } = input.parse(args);
    const userId = ctx.principal.userId;
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    if (action === 'get') return readStewardNote(projectId, subjectKind, key);
    if (!note) throw new Error('forge_steward_note: write takes `note`');
    return {
      note: await writeStewardNote({
        projectId,
        kind: subjectKind,
        key,
        write: note,
        userId,
        access,
      }),
    };
  },
});
