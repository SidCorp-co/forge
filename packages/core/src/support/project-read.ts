// The project document as a channel agent reads it (ISS-775, REQ-77 BC-22): what the project says it
// is and runs — its source, environments and their deploy bindings — read through Forge, never off a
// file of the box. A customer support group's session is not given it: environments and bindings are
// the team's facts, not a product user's.

import { scrubSecretsDeep } from '@forge/observability';
import { readProjectDocument } from '../project-config/index.js';
import type { OpsOutcome } from './ops-types.js';
import { namedProject } from './ops-scope.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';

/** The project document of the home project, or of a project the agent follows that `project` names (ISS-874). */
export async function readProjectFacts(
  room: RoomRow,
  project?: string,
): Promise<OpsOutcome<unknown>> {
  if (room.kind !== 'agent') {
    return no(
      'SUPPORT_NOT_A_CHANNEL_AGENT',
      '/action',
      "project reads the project document, which a channel agent's team reads and a support group's product users do not; answer from search instead",
    );
  }
  const named = await namedProject(room, project);
  if (!named.ok) return named;
  const held = await readProjectDocument(named.value.id);
  return {
    ok: true,
    value: held
      ? scrubSecretsDeep({
          project: named.value.slug,
          declared: true,
          revision: held.revision,
          document: held.document,
        })
      : { project: named.value.slug, declared: false, revision: null, document: null },
  };
}
