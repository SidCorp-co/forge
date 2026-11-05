// What Forge shows of a support group or an operations room (REQ-75 BC-18): its rooms with their
// session, and every action taken in one, oldest first. Inputs and outputs were stored scrubbed.

import {
  SUPPORT_DELIVERY_PATHS,
  SUPPORT_LATENCY_WINDOW,
  type SupportActionView,
  type SupportApiView,
  type SupportLatencyView,
  type SupportRoomView,
} from '@forge/contracts/support';
import { sessionStatusesByIds } from '../agent-sessions/index.js';
import { externalItemPhases } from '../feedback/index.js';
import { readSupportApis } from '../integrations/support-api/index.js';
import { requireDeclaredOn } from '../permissions/index.js';
import { latencySamples } from './delivery.js';
import { answersOfConfig, readersOfConfig, supportConfigOf } from './grants.js';
import { roomHealth } from './health.js';
import { roleOfRoom } from './ops-role.js';
import { heldRoomsOfProject } from './rooms.js';
import { percentile } from './rules.js';
import { type ActionRow, actionsOfRoom, recentThreads, roomById } from './store.js';
import { projectThreadOfRoom } from './thread.js';

const ACTIONS_SHOWN = 500;

export async function supportRoomsOf(
  viewer: string,
  projectId: string,
): Promise<SupportRoomView[]> {
  await requireDeclaredOn(projectId, viewer, 'project.read');
  // a released room is no room the project holds (ISS-933)
  const rooms = await heldRoomsOfProject(projectId);
  if (rooms.length === 0) return [];
  const statusOf = await sessionStatusesByIds(
    rooms.flatMap((r) => (r.sessionId ? [r.sessionId] : [])),
  );
  const supportApis = await supportApisView(projectId);
  return Promise.all(
    rooms.map(async (r) => {
      const session = r.sessionId ? statusOf.get(r.sessionId) : undefined;
      const config = await supportConfigOf(r);
      const { health, name } = await roomHealth(r);
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
        supportApis,
        name,
        readers: readersOfConfig(r, config),
        answers: answersOfConfig(r, config),
        grants: config?.grants ?? null,
        health,
        threads: (await recentThreads(r.id, 1000)).length,
        projectThread: await projectThreadOfRoom(r),
        latency: latencyOf(await latencySamples(r.id, SUPPORT_LATENCY_WINDOW)),
        createdAt: r.createdAt.toISOString(),
      };
    }),
  );
}

/**
 * Every support API the project grants, each with its tools or the fault that keeps the door from
 * calling it: one that does not parse is shown with why, never dropped from the list.
 */
async function supportApisView(projectId: string): Promise<SupportApiView[]> {
  return (await readSupportApis(projectId)).map((r) =>
    r.ok
      ? {
          bindingId: r.api.bindingId,
          name: r.api.name,
          tools: r.api.tools.map((t) => ({ name: t.name, kind: t.kind })),
          fault: null,
        }
      : { bindingId: r.bindingId, name: r.name, tools: [], fault: r.fault },
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
  await requireDeclaredOn(projectId, viewer, 'project.read');
  const room = await roomById(roomId);
  if (!room || room.projectId !== projectId) return null;
  const rows = await actionsOfRoom(room.id, ACTIONS_SHOWN);
  const ids = [...new Set(rows.flatMap((r) => (r.feedbackId ? [r.feedbackId] : [])))];
  const items = await externalItemPhases(projectId, ids);
  const keys = new Map([...items].map(([id, item]) => [id, item.key]));
  return rows.map((r) => viewOf(r, keys));
}
