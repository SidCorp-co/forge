// What Forge shows of a support group or an operations room (REQ-75 BC-18): its rooms with their
// session, and every action taken in one, oldest first. Inputs and outputs were stored scrubbed.

import {
  SUPPORT_DELIVERY_PATHS,
  SUPPORT_LATENCY_WINDOW,
  type SupportActionView,
  type SupportLatencyView,
  type SupportRoomView,
} from '@forge/contracts/support';
import { sessionStatusesByIds } from '../agent-sessions/index.js';
import { externalItemPhases } from '../feedback/index.js';
import { activeSupportApi } from '../integrations/support-api/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { latencySamples } from './delivery.js';
import { roleOfRoom } from './ops-role.js';
import { percentile } from './rules.js';
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
    rooms.map(async (r) => {
      const session = r.sessionId ? statusOf.get(r.sessionId) : undefined;
      return {
        id: r.id,
        projectId: r.projectId,
        bindingId: r.bindingId,
        rid: r.rid,
        kind: r.kind,
        scope: r.scope,
        role: r.kind === 'operations' ? await roleName(r) : null,
        sessionId: r.sessionId,
        sessionStatus: session?.status ?? null,
        resident: session?.status === 'running' || session?.runtimeState === 'awaiting_input',
        principalUserId: r.principalUserId,
        toolCount: api?.tools.length ?? 0,
        threads: (await recentThreads(r.id, 1000)).length,
        latency: latencyOf(await latencySamples(r.id, SUPPORT_LATENCY_WINDOW)),
        createdAt: r.createdAt.toISOString(),
      };
    }),
  );
}

/** The role an operations room's bot answers under, by name; null where it carries none it can read. */
async function roleName(room: Parameters<typeof roleOfRoom>[0]): Promise<string | null> {
  const role = await roleOfRoom(room);
  return role.ok ? role.value.name : null;
}

/** p50 and p95 of the samples, overall and by how each message reached the session. */
export function latencyOf(samples: { ms: number; path: string | null }[]): SupportLatencyView {
  const stats = (ms: number[]) => ({
    measured: ms.length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
  });
  const byPath = Object.fromEntries(
    SUPPORT_DELIVERY_PATHS.map((p) => [
      p,
      stats(samples.filter((s) => s.path === p).map((s) => s.ms)),
    ]),
  ) as SupportLatencyView['byPath'];
  return { ...stats(samples.map((s) => s.ms)), byPath };
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
