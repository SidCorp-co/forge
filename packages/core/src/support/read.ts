// What Forge shows of a support group (REQ-75 BC-18): its rooms with their session, and every action
// taken in one, oldest first. Inputs and outputs were stored scrubbed.

import type { SupportActionView, SupportRoomView } from '@forge/contracts/support';
import { sessionStatusesByIds } from '../agent-sessions/index.js';
import { externalItemPhases } from '../feedback/index.js';
import { activeSupportApi } from '../integrations/support-api/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type ActionRow, actionsOfRoom, recentThreads, roomById, roomsOfProject } from './store.js';

const ACTIONS_SHOWN = 500;

export async function supportRoomsOf(
  viewer: string,
  projectId: string,
): Promise<SupportRoomView[]> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const rooms = await roomsOfProject(projectId);
  if (rooms.length === 0) return [];
  const statusOf = await sessionStatusesByIds(
    rooms.flatMap((r) => (r.sessionId ? [r.sessionId] : [])),
  );
  const api = await activeSupportApi(projectId).catch(() => null);
  return Promise.all(
    rooms.map(async (r) => ({
      id: r.id,
      projectId: r.projectId,
      bindingId: r.bindingId,
      rid: r.rid,
      sessionId: r.sessionId,
      sessionStatus: r.sessionId ? (statusOf.get(r.sessionId) ?? null) : null,
      principalUserId: r.principalUserId,
      toolCount: api?.tools.length ?? 0,
      threads: (await recentThreads(r.id, 1000)).length,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

function viewOf(row: ActionRow, keys: Map<string, string>): SupportActionView {
  return {
    id: row.id,
    kind: row.kind,
    thread: row.thread,
    conversationId: row.conversationId,
    actor: { kind: row.actorKind, account: row.actorKey, label: row.actorLabel },
    tool: row.tool,
    input: row.input,
    output: row.output,
    feedbackKey: row.feedbackId ? (keys.get(row.feedbackId) ?? null) : null,
    at: row.createdAt.toISOString(),
  };
}

/** A room's actions, or null when the project holds no such room. */
export async function supportActionsOf(
  viewer: string,
  projectId: string,
  roomId: string,
): Promise<SupportActionView[] | null> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const room = await roomById(roomId);
  if (!room || room.projectId !== projectId) return null;
  const rows = await actionsOfRoom(room.id, ACTIONS_SHOWN);
  const ids = [...new Set(rows.flatMap((r) => (r.feedbackId ? [r.feedbackId] : [])))];
  const items = await externalItemPhases(projectId, ids);
  const keys = new Map([...items].map(([id, item]) => [id, item.key]));
  return rows.map((r) => viewOf(r, keys));
}
