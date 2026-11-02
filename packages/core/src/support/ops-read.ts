// The governed read door (ISS-871, REQ-77 BC-3): a room's grant declares named reads, each a fixed
// argv on the box and typed parameters. The agent names a read and its arguments; core checks each
// argument whole against its parameter before anything runs, the box runs the argv with no shell and
// the arguments as their own items, and core scrubs what came back before the agent reads it. A read
// runs at once and needs no confirmer: the program reads, and keeps its own credential. The agent is
// never shown the argv, only the read's name, summary and parameters.

import { SUPPORT_READ_TIMEOUT_DEFAULT_MS, type SupportReadResult } from '@forge/contracts/support';
import { runOpsRead } from '../runners/index.js';
import { boxOfRoom } from './box.js';
import { firingOf } from './checks.js';
import { abilityRefusal, grantsOf, supportConfigOf } from './grants.js';
import { type ReadArgs, readArgv } from './ops-read-args.js';
import type { OpsOutcome } from './ops-types.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { scrubbedForRoom, TOP_LEVEL } from './thread.js';

/** Where a read is recorded: the member thread it answers, the check it serves, or the group's top. */
async function placeOf(
  room: RoomRow,
  input: { thread?: string | undefined; check?: string | undefined },
): Promise<Outcome<{ thread: string; conversationId: string | null }>> {
  if (input.thread) {
    const conversationId = await knownThread(room, input.thread);
    if (!conversationId) return threadUnknown(input.thread);
    return { ok: true, value: { thread: input.thread, conversationId } };
  }
  if (input.check) {
    if (!(await firingOf(room, input.check))) {
      return no(
        'SUPPORT_CHECK_UNKNOWN',
        '/check',
        `no scheduled check fired as ${input.check} in this group; name the check thread you were handed`,
      );
    }
    return { ok: true, value: { thread: input.check, conversationId: null } };
  }
  return { ok: true, value: { thread: TOP_LEVEL, conversationId: null } };
}

/**
 * Run a read the room's grant declares (`ops_reads`): refused by name when the ability is not
 * granted, the read is not declared, or an argument does not fit; otherwise run at once through the
 * box, scrubbed, recorded, and handed to the session. Nothing is posted.
 */
export async function runRead(
  room: RoomRow,
  input: {
    name: string;
    args?: ReadArgs | undefined;
    thread?: string | undefined;
    check?: string | undefined;
  },
): Promise<OpsOutcome<SupportReadResult>> {
  const place = await placeOf(room, input);
  if (!place.ok) return place;
  const { thread, conversationId } = place.value;
  const asked = { name: input.name, args: input.args ?? {} };
  const record = async (out: Outcome<SupportReadResult>) => {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread,
      kind: out.ok ? 'diagnose' : 'refused',
      actorKind: out.ok ? 'session' : 'core',
      tool: 'read',
      input: asked,
      output: out.ok ? out.value : { refusals: out.refusals },
    });
    return out;
  };
  const grants = grantsOf(await supportConfigOf(room));
  const refused = await abilityRefusal(room, grants, 'ops_reads');
  if (refused) return record(refused);
  const read = (grants.reads ?? []).find((r) => r.name === input.name);
  if (!read) {
    const names = (grants.reads ?? []).map((r) => r.name).join(', ');
    return record(
      no(
        'SUPPORT_READ_UNDECLARED',
        '/name',
        `this room's grant declares no read ${input.name}; it declares ${names || 'none'}. Nothing ran.`,
      ),
    );
  }
  const argv = readArgv(read, asked.args);
  if (!argv.ok) return record(argv);
  const box = await boxOfRoom(room, 'reads');
  if (!box.ok) return record(box);
  const ran = await runOpsRead({
    deviceId: box.value,
    projectId: room.projectId,
    name: read.name,
    argv: argv.value,
    timeoutMs: read.timeoutMs ?? SUPPORT_READ_TIMEOUT_DEFAULT_MS,
  });
  if (!ran.ok) {
    // the box's words can name the program it could not run: scrubbed of the argv as of any secret
    const why = (await scrubbedForRoom(room, ran.why))
      .split(read.argv[0] as string)
      .join(read.name);
    return record(no('SUPPORT_READ_FAILED', '/name', `${read.name} did not run: ${why}`));
  }
  return record({
    ok: true,
    value: {
      ...ran.value,
      stdout: await scrubbedForRoom(room, ran.value.stdout),
      stderr: await scrubbedForRoom(room, ran.value.stderr),
    },
  });
}
