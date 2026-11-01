// The acts a room's grant opens (REQ-75 r5 BC-27): move an issue as the member who asked
// (`deliver`), run a command on a named host (`run_commands`), deploy a bound target (`deploy`) and
// push a build (`build`). Each is gated by the room's grant first (`grants.ts`), refused by name when
// not granted (BC-28). A command that only reads runs at once; a build, a deploy and a command that
// changes a host are proposed and run only once a confirmer agrees (`fixes.ts:agreeTo`,
// `ability-run.ts`). Every result goes back to the session as the act's answer; core posts nothing.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { SupportCommandResult, SupportGrants } from '@forge/contracts/support';
import { listActiveDeployBindingsForProvider } from '../integrations/index.js';
import { isRefusal } from '../lib/refusal.js';
import { deployAdapterForBinding } from '../project-config/index.js';
import { runHostCommand } from '../runners/index.js';
import { boxOfRoom } from './box.js';
import { buildBaseOf } from './build.js';
import { classifyCommand } from './command-class.js';
import { whoConfirms } from './confirm-role.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import type { OpsOutcome } from './ops-types.js';
import { move } from './ops-writes.js';
import { knownThread, no, threadUnknown } from './outcome.js';
import { offerChange } from './propose.js';
import { insertAction, latestThreadWriter, type RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

async function grantOf(room: RoomRow): Promise<SupportGrants> {
  return grantsOf(await supportConfigOf(room));
}

/** The member a confirmer-gated change is offered for: the thread's latest writer. */
async function askingMember(room: RoomRow, thread: string) {
  return latestThreadWriter(room.id, thread);
}

/** Move an issue of the room's project as the member who asked (`deliver`). */
export async function moveIssue(
  room: RoomRow,
  input: { thread: string; issue: string; to: IssueStatus; reason?: string | undefined },
): Promise<OpsOutcome<unknown>> {
  const refused = await abilityRefusal(room, await grantOf(room), 'deliver');
  if (refused) return refused;
  if (!(await knownThread(room, input.thread))) return threadUnknown(input.thread);
  const out = await move(room, { action: 'move', ...input });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: input.thread,
    kind: out.ok ? 'operation' : 'refused',
    actorKind: 'session',
    tool: 'move_issue',
    input,
    output: out.ok ? out.value : { refusals: out.refusals },
  });
  return out;
}

/** One command's answer as the session and the thread see it: scrubbed of every secret the room holds. */
export async function scrubbedResult(
  room: RoomRow,
  result: SupportCommandResult,
): Promise<SupportCommandResult> {
  return {
    ...result,
    stdout: await scrubbedForRoom(room, result.stdout),
    stderr: await scrubbedForRoom(room, result.stderr),
  };
}

/**
 * Run a command on a host the room's grant names (`run_commands`). One that only reads runs at once
 * through the box; any other is proposed and waits for a confirmer.
 */
export async function runCommand(
  room: RoomRow,
  input: { thread: string; host: string; command: string },
): Promise<OpsOutcome<unknown>> {
  const grants = await grantOf(room);
  const refused = await abilityRefusal(room, grants, 'run_commands', { host: input.host });
  if (refused) return refused;
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const cls = classifyCommand(input.command);
  if (!cls.reads) {
    const asker = await askingMember(room, input.thread);
    if (!asker) return threadUnknown(input.thread);
    const out = await offerChange({
      room,
      thread: input.thread,
      asker,
      change: { kind: 'command' },
      waitsOn: whoConfirms(room, grants),
      args: { host: input.host, command: input.command, why: cls.why },
    });
    return out.ok ? { ok: true, value: { ...out.value, changes: cls.why } } : out;
  }
  const box = await boxOfRoom(room, 'commands');
  if (!box.ok) return box;
  const ran = await runHostCommand({
    deviceId: box.value,
    projectId: room.projectId,
    host: input.host,
    command: input.command,
  });
  if (!ran.ok) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'command',
      input,
      output: { reason: ran.why },
    });
    return no('SUPPORT_COMMAND_FAILED', '/command', `nothing ran on ${input.host}: ${ran.why}`);
  }
  const result = await scrubbedResult(room, ran.value);
  // the output is the session's to read and tell; nothing is posted in the room (ISS-845)
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'diagnose',
    actorKind: 'session',
    tool: 'command',
    input,
    output: result,
  });
  return { ok: true, value: result };
}

/** Propose a deploy of a bound target the room's grant names (`deploy`). */
export async function proposeDeploy(
  room: RoomRow,
  input: { thread: string; target: string },
): Promise<OpsOutcome<unknown>> {
  const grants = await grantOf(room);
  const refused = await abilityRefusal(room, grants, 'deploy', { target: input.target });
  if (refused) return refused;
  if (!(await knownThread(room, input.thread))) return threadUnknown(input.thread);
  const bound = (await listActiveDeployBindingsForProvider(room.projectId, 'coolify')).find(
    (p) => p.binding.id === input.target,
  );
  if (!bound) {
    return no(
      'SUPPORT_ABILITY_NOT_GRANTED',
      '/target',
      `${input.target} is named in this room's grant and is no active deploy binding of this project any more, so nothing can be deployed through it`,
    );
  }
  const label = bound.binding.label || bound.connection.displayName || input.target;
  const asker = await askingMember(room, input.thread);
  if (!asker) return threadUnknown(input.thread);
  const out = await offerChange({
    room,
    thread: input.thread,
    asker,
    change: { kind: 'deploy' },
    waitsOn: whoConfirms(room, grants),
    args: { target: input.target, label },
  });
  return out;
}

/** How long the platform has to answer a deployment read before the read says so. */
const DEPLOYMENT_READ_MS = 10_000;

/**
 * The latest deployment record of a deploy binding the room's grant names (`deploy`): what the agent
 * reads to watch a deploy after a merge, through Forge and never a shell on the host (ISS-775). It
 * reads and posts nothing.
 */
export async function readDeployment(
  room: RoomRow,
  input: { target: string },
): Promise<OpsOutcome<unknown>> {
  const grants = await grantOf(room);
  const refused = await abilityRefusal(room, grants, 'deploy', { target: input.target });
  if (refused) return refused;
  const unreadable = (why: string) =>
    no(
      'SUPPORT_DEPLOYMENT_UNREADABLE',
      '/target',
      `the deployment record of ${input.target} could not be read: ${why}`,
    );
  try {
    const bound = await deployAdapterForBinding(room.projectId, input.target, DEPLOYMENT_READ_MS);
    if (!bound) return unreadable('it is no active deploy binding of this project any more');
    const record = await bound.adapter.latestDeployment(bound.target);
    return {
      ok: true,
      value: {
        target: input.target,
        provider: bound.adapter.provider,
        deployment: record
          ? {
              id: record.id,
              status: record.status,
              at: record.at,
              sourceRevision: record.sourceRevision,
            }
          : null,
      },
    };
  } catch (err) {
    if (isRefusal(err)) return unreadable(err.refusals.map((r) => r.detail).join('; '));
    return unreadable(err instanceof Error ? err.message : String(err));
  }
}

/** Propose pushing the room's working copy as a build (`build`). */
export async function proposeBuild(
  room: RoomRow,
  input: { thread: string; branch: string; title: string; summary: string },
): Promise<OpsOutcome<unknown>> {
  const grants = await grantOf(room);
  const refused = await abilityRefusal(room, grants, 'build');
  if (refused) return refused;
  if (!(await knownThread(room, input.thread))) return threadUnknown(input.thread);
  const base = await buildBaseOf(room.projectId, input.branch);
  if (!base.ok) return base;
  const asker = await askingMember(room, input.thread);
  if (!asker) return threadUnknown(input.thread);
  const out = await offerChange({
    room,
    thread: input.thread,
    asker,
    change: { kind: 'build' },
    waitsOn: whoConfirms(room, grants),
    args: { ...input, base: base.value.base },
  });
  return out;
}
