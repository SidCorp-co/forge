// A room agent records a term a person names (ISS-1256 c9; owner 2026-11-16: "a person names a thing
// → write a term"): the project's glossary entry under its module, the person's word an alias and
// their message quoted as who named it. It runs the knowledge door's own write
// (`knowledge/upsert.ts:upsertKnowledgeEntry`), so a wrong module, alias shape or anchor is refused by
// the same codes. Grants decide: the person whose message it cites must hold project.write on the
// project, as an operations write does (`ops-writes.ts`); the entry is the room agent's, written on
// their word, never one core composes. One who may not is refused by name, and the room agent hands
// the word to the project's master.

import type { SupportTermRequest } from '@forge/contracts/support-terms';
import { upsertKnowledgeEntry } from '../knowledge/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { askerOf } from './ops-asker.js';
import { namedProject } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { asAsker, refusalsOf } from './ops-writes.js';
import type { RoomRow } from './store.js';

export type TermActInput = { action: 'term' } & SupportTermRequest;

/** `term`: the thing a person named, written into the project's glossary as the room agent's. */
export async function termAct(room: RoomRow, input: TermActInput): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  const asker = await askerOf(room, input.thread, input.message, 'project.write');
  if (!asker.ok) return asker;
  const { id, slug } = project.value;
  const who = asker.value.label ?? asker.value.key;
  return refusalsOf(() =>
    asAsker(asker.value, id, async () => {
      await requireCan(
        actorFor(asker.value.userId),
        'project.write',
        projectResource(id),
        'recording a term they named (send it with support.ask_master instead)',
      );
      const written = await upsertKnowledgeEntry(
        {
          projectId: id,
          slug: input.slug,
          title: input.title,
          body: input.means,
          kind: 'glossary',
          injection: 'on_demand',
          confidence: 'inferred',
          authoredBy: 'agent',
          orderIndex: 0,
          module: input.module,
          term: {
            ...(input.aliases ? { aliases: input.aliases } : {}),
            namedBy: { who, quote: input.quote },
          },
          ...(input.anchor ? { anchor: input.anchor } : {}),
        },
        { userId: room.principalUserId, agency: 'agent' },
      );
      return {
        ok: true as const,
        value: { project: slug, term: written.slug, module: input.module, namedBy: who },
      };
    }),
  );
}
