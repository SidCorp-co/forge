// An operations room's acts (REQ-75 BC-20..BC-24), behind the same check every support act passes
// (the caller is the room's own session, `access.ts`). Each is gated twice before anything runs: by
// the role's grant (`ops-role.ts`), and by the room's scope (`ops-scope.ts`). A read runs as the
// room (`ops-reads.ts`); a write runs as the thread's asker under their own permissions
// (`ops-writes.ts`).

import type { OperationsAction } from '@forge/contracts/support-operations';
import { issuesRead, projectsRead, releasesRead } from './ops-reads.js';
import { readPublicPage } from './ops-research.js';
import { grantRefusal, roleOfRoom } from './ops-role.js';
import type { OperationsActInput, OpsOutcome } from './ops-types.js';
import { draftFeedbackAct, draftRequirementAct, move } from './ops-writes.js';
import { no } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type { OperationsActInput, OpsOutcome } from './ops-types.js';

/** The act, gated by the room's kind, its role's grant and its scope. */
export async function operationsAct(
  room: RoomRow,
  input: OperationsActInput,
): Promise<OpsOutcome<unknown>> {
  if (room.kind !== 'operations') {
    return no(
      'OPS_NOT_AN_OPERATIONS_ROOM',
      '/action',
      `${input.action} is an operations room's act, and this room is a support group`,
    );
  }
  const role = await roleOfRoom(room);
  if (!role.ok) return role;
  const lacking = grantRefusal(role.value, input.action);
  const out = lacking ?? (await act(room, input));
  if ('thread' in input) await recordOperation(room, input, out);
  return out;
}

async function act(room: RoomRow, input: OperationsActInput): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'projects':
      return { ok: true, value: { projects: await projectsRead(room) } };
    case 'issues':
      return issuesRead(room, input);
    case 'releases':
      return releasesRead(room, input.project);
    case 'move':
      return move(room, input);
    case 'draft_requirement':
      return draftRequirementAct(room, input);
    case 'draft_feedback':
      return draftFeedbackAct(room, input);
    case 'research':
      return readPublicPage(input.url);
  }
}

/** A write or a page read, recorded on the room as an `operation` (or `refused`) action. */
async function recordOperation(
  room: RoomRow,
  input: OperationsActInput & { thread: string },
  out: OpsOutcome<unknown>,
): Promise<void> {
  const { action, thread, ...args } = input;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'session',
    tool: action satisfies OperationsAction,
    input: args,
    output: out.ok ? out.value : { refusals: out.refusals },
  });
}
