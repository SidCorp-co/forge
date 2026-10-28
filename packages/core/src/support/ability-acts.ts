// The acts a room's grant opens (REQ-75 r5 BC-27): move an issue as the member who asked
// (`deliver`), run a command on a named host (`run_commands`), deploy a bound target (`deploy`) and
// push a build (`build`). Each is gated by the room's grant first (`grants.ts`), refused by name when
// not granted (BC-28). A command that only reads runs at once; a build, a deploy and a command that
// changes a host are proposed and run only on a confirmer's `confirm <code>` (`ability-run.ts`).

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { SupportCommandResult, SupportGrants } from '@forge/contracts/support';
import { listActiveDeployBindingsForProvider } from '../integrations/index.js';
import { runHostCommand } from '../runners/index.js';
import { boxOfRoom } from './box.js';
import { buildBaseOf } from './build.js';
import { classifyCommand } from './command-class.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import type { OpsOutcome } from './ops-types.js';
import { move } from './ops-writes.js';
import { knownThread, no, threadUnknown } from './outcome.js';
import { offerChange } from './propose.js';
import { insertAction, latestThreadWriter, type RoomRow } from './store.js';
import { postInThread, scrubbedForRoom } from './thread.js';

async function grantOf(room: RoomRow): Promise<SupportGrants> {
  return grantsOf(await supportConfigOf(room));
}

const confirmersOf = (g: SupportGrants) => (g.confirmers ?? []).map((c) => `@${c}`).join(', ');

/** What every confirmer-gated prompt ends with: who confirms, how, and for how long. */
const confirmTail = (g: SupportGrants, code: string) =>
  `${confirmersOf(g)} can confirm it: reply \`confirm ${code}\` to go ahead, or \`cancel ${code}\`. It expires in 15 minutes.`;

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

/** The line a command posts once it ran. */
export function commandLine(host: string, command: string, r: SupportCommandResult): string {
  const outcome = r.timedOut
    ? 'stopped at its time limit'
    : r.exitCode === 0
      ? 'exit 0'
      : `exit ${r.exitCode ?? 'unknown'}`;
  return `Ran on ${host}: \`${command}\` — ${outcome} (${r.durationMs} ms).`;
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
      waitsOn: confirmersOf(grants),
      args: { host: input.host, command: input.command, why: cls.why },
      prompt: (code) =>
        `I would run on ${input.host}: \`${input.command}\`. It can change the host (${cls.why}), so it waits for a confirmer. ${confirmTail(grants, code)}`,
    });
    return out.ok
      ? { ok: true, value: { pending: true, code: out.code, waitsOn: grants.confirmers } }
      : out;
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
  const posted = await postInThread({
    room,
    thread: input.thread,
    text: commandLine(input.host, input.command, result),
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: posted.conversationId,
    thread: input.thread,
    kind: 'diagnose',
    actorKind: 'session',
    tool: 'command',
    input,
    output: result,
    externalId: posted.messageId,
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
    waitsOn: confirmersOf(grants),
    args: { target: input.target, label },
    prompt: (code) =>
      `I would deploy ${label} now. A production target still waits for its approver after this. ${confirmTail(grants, code)}`,
  });
  return out.ok ? { ok: true, value: { pending: true, code: out.code } } : out;
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
  const base = await buildBaseOf(room.projectId);
  if (!base.ok) return base;
  const asker = await askingMember(room, input.thread);
  if (!asker) return threadUnknown(input.thread);
  const out = await offerChange({
    room,
    thread: input.thread,
    asker,
    change: { kind: 'build' },
    waitsOn: confirmersOf(grants),
    args: { ...input, base: base.value.base },
    prompt: (code) =>
      `I would commit my changes on ${input.branch}, push it and open a change request into ${base.value.base}: "${input.title}". Nothing merges into production from here. ${confirmTail(grants, code)}`,
  });
  return out.ok ? { ok: true, value: { pending: true, code: out.code } } : out;
}
