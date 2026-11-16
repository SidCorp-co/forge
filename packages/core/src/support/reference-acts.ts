// A room agent's acts on a project's reference sources (ISS-1252; owner 2026-11-16: he adds a source
// in plain words to the agent he talks to, and that agent records it; bots consult sources first).
// Each runs the function the references REST door and forge_references run (`references/`), on a
// project of the room's reach (`ops-scope.ts:namedProject`), so a refusal comes back with the same
// codes. An add is the person's: it runs as the writer of the message that asked for it, under their
// own Forge permission on the project, as an operations write does (`ops-writes.ts`); a citation and
// a proposal are the room agent's own.

import type {
  supportReferenceAddRequestSchema,
  supportReferenceCiteRequestSchema,
  supportReferenceProposeRequestSchema,
  supportReferencesRequestSchema,
} from '@forge/contracts/support-references';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { currentPatScope, runWithPatScope } from '../credentials/pat-scope.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { addSource, citeSource, proposeSource, searchSources } from '../references/index.js';
import { askerOf } from './ops-asker.js';
import { namedProject } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker, refusalsOf } from './ops-writes.js';
import { no } from './outcome.js';
import { noteRoomReached } from './room-reaches.js';
import type { RoomRow } from './store.js';

type ReferencesReadInput = Omit<z.output<typeof supportReferencesRequestSchema>, 'project'> & {
  project?: string | undefined;
};
export type ReferenceAddInput = z.output<typeof supportReferenceAddRequestSchema>;
export type ReferenceCiteInput = z.output<typeof supportReferenceCiteRequestSchema>;
export type ReferenceProposeInput = z.output<typeof supportReferenceProposeRequestSchema>;

/** The reference acts, every room's (ISS-1252). */
export const REFERENCE_ACTS = [
  'references',
  'reference_add',
  'reference_cite',
  'reference_propose',
] as const;

/** A reference act as the room's session names it. */
export type ReferenceActInput =
  | ({ action: 'references' } & ReferencesReadInput)
  | ({ action: 'reference_add' } & ReferenceAddInput)
  | ({ action: 'reference_cite' } & ReferenceCiteInput)
  | ({ action: 'reference_propose' } & ReferenceProposeInput);

/** The act, by its name. */
export function referenceAct(
  room: RoomRow,
  input: ReferenceActInput,
): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'references': {
      const { action: _, ...request } = input;
      return referencesRead(room, request);
    }
    case 'reference_add': {
      const { action: _, ...request } = input;
      return referenceAdd(room, request);
    }
    case 'reference_cite': {
      const { action: _, ...request } = input;
      return referenceCite(room, request);
    }
    case 'reference_propose': {
      const { action: _, ...request } = input;
      return referencePropose(room, request);
    }
  }
}

/**
 * Run `fn` as the room's own agent on `projectId`: the turn's token, held by the room's account, fenced
 * to that one project of the room's reach (a followed project lies outside the turn's own fence).
 */
function asRoomAgent<T>(room: RoomRow, projectId: string, fn: () => Promise<T>): Promise<T> {
  const turn = currentPatScope();
  if (!turn) throw new Error('support: a reference act ran with no token to act on');
  return runWithPatScope(
    {
      projectIds: [projectId],
      tokenId: turn.tokenId,
      userId: room.principalUserId,
      agency: 'agent',
      grant: ['*'],
      scopes: ['read', 'write'],
    },
    fn,
  );
}

/** `references`: the project's active sources, every one or those an area or words name. */
export async function referencesRead(
  room: RoomRow,
  input: ReferencesReadInput,
): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const sources = await searchSources(project.value.id, {
    ...(input.area ? { area: input.area } : {}),
    ...(input.q ? { q: input.q } : {}),
  });
  noteRoomReached(room, project.value.id, 'search', {
    records: sources.map((s) => ({
      kind: 'reference' as const,
      ref: s.id,
      text: `${s.title}\n${s.url}\n${s.why}`,
    })),
  });
  return { ok: true, value: { project: project.value.slug, sources } };
}

/** `reference_add`: the source a person named, added as them under their own permission. */
export async function referenceAdd(
  room: RoomRow,
  input: ReferenceAddInput,
): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread, input.message, 'project.write');
  if (!asker.ok) return asker;
  const { thread: _t, message: _m, project: _p, ...request } = input;
  const { id, slug } = project.value;
  return refusalsOf(() =>
    asAsker(asker.value, id, async () => {
      await requireCan(
        actorFor(asker.value.userId),
        'project.write',
        projectResource(id),
        'adding a reference source',
      );
      // his plain words are the add: he is recorded as who added it, not the room agent
      const added = await addSource({
        projectId: id,
        actor: { userId: asker.value.userId, agency: 'human' },
        request,
      });
      if (!added.ok) return { ok: false as const, refusals: added.refusals };
      return {
        ok: true as const,
        value: {
          act: added.act,
          project: slug,
          source: added.source,
          as: asker.value.label ?? asker.value.key,
        },
      };
    }),
  );
}

/** `reference_cite`: one use of a source, the room agent's. */
export async function referenceCite(
  room: RoomRow,
  input: ReferenceCiteInput,
): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const { source, project: _p, ...request } = input;
  try {
    const cited = await asRoomAgent(room, project.value.id, () =>
      citeSource({
        projectId: project.value.id,
        actor: { userId: room.principalUserId, agency: 'agent' },
        ref: source,
        request,
      }),
    );
    return { ok: true, value: { act: cited.act, project: project.value.slug, ...cited.citation } };
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      return no(
        'SUPPORT_REFERENCE_UNKNOWN',
        '/source',
        `${project.value.slug} reads no active reference source "${source}": name one support.references lists, by its id, address or name`,
      );
    }
    throw err;
  }
}

/** `reference_propose`: a source the room agent kept using, recorded as its proposal. */
export async function referencePropose(
  room: RoomRow,
  input: ReferenceProposeInput,
): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const { project: _p, ...request } = input;
  const proposed = await asRoomAgent(room, project.value.id, () =>
    proposeSource({
      projectId: project.value.id,
      actor: { userId: room.principalUserId, agency: 'agent' },
      request,
    }),
  );
  if (!proposed.ok) return { ok: false, refusals: proposed.refusals };
  return {
    ok: true,
    value: { act: proposed.act, project: project.value.slug, source: proposed.source },
  };
}
