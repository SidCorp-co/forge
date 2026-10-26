// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule. A
// support group's acts and an operations room's (`ops-acts.ts`) share the reply and thread reads;
// each kind's own acts are refused in the other's room by name.

import type { SupportRecordKind } from '@forge/contracts/support';
import { OPERATIONS_ACTIONS } from '@forge/contracts/support-operations';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import { sessionCaller } from './access.js';
import { settleLatency } from './delivery.js';
import { type OperationsActInput, type OpsOutcome, operationsAct } from './ops-acts.js';
import { no } from './outcome.js';
import { proposeFix, proposeRecord } from './propose.js';
import { search } from './search.js';
import { listTools, readThread, reply, runDiagnose } from './service.js';
import type { RoomRow } from './store.js';

export interface SupportCaller {
  userId: string;
  tokenId: string | null | undefined;
  projectId: string;
}

type ToolCall = { thread: string; tool: string; args?: SupportCallArgs | undefined };

export type SupportActInput =
  | OperationsActInput
  | { action: 'search'; query: string }
  | { action: 'thread'; thread: string }
  | { action: 'tools' }
  | { action: 'reply'; thread: string; text: string }
  | ({ action: 'run' } & ToolCall)
  | ({ action: 'propose_fix'; asker: string } & ToolCall)
  | {
      action: 'record';
      thread: string;
      kind: SupportRecordKind;
      title: string;
      summary: string;
      whereSeen?: string | undefined;
      asker?: string | undefined;
    };

export async function supportAct(
  caller: SupportCaller,
  input: SupportActInput,
): Promise<OpsOutcome<unknown>> {
  const room = await sessionCaller(caller);
  const out = isOperation(input)
    ? await operationsAct(room, input)
    : room.kind === 'support' || SHARED.has(input.action)
      ? await act(room, input)
      : no(
          'SUPPORT_NOT_A_SUPPORT_ROOM',
          '/action',
          `${input.action} is a support group's act, and this room is an operations room: its acts are ${OPERATION_ACTIONS.join(', ')}, reply and thread`,
        );
  // the session's first post in a thread answers every message of it the session had been handed
  if (out.ok && 'thread' in input && POSTS.has(input.action)) {
    await settleLatency(room.id, input.thread, new Date());
  }
  return out;
}

/** The acts that post in the thread they name. */
const POSTS = new Set<SupportActInput['action']>(['reply', 'run', 'propose_fix', 'record']);

/** The acts both kinds of room take. */
const SHARED = new Set<SupportActInput['action']>(['reply', 'thread']);

const OPERATION_ACTIONS: readonly string[] = OPERATIONS_ACTIONS;
const isOperation = (input: SupportActInput): input is OperationsActInput =>
  OPERATION_ACTIONS.includes(input.action);

type SupportOnlyInput = Exclude<SupportActInput, OperationsActInput>;

async function act(room: RoomRow, input: SupportOnlyInput): Promise<OpsOutcome<unknown>> {
  switch (input.action) {
    case 'search':
      return search(room, input.query);
    case 'thread':
      return readThread(room, input.thread);
    case 'tools':
      return listTools(room);
    case 'reply':
      return reply(room, { thread: input.thread, text: input.text });
    case 'run':
      return runDiagnose(room, { thread: input.thread, tool: input.tool, args: input.args ?? {} });
    case 'propose_fix': {
      const out = await proposeFix({
        room,
        thread: input.thread,
        tool: input.tool,
        args: input.args ?? {},
        asker: input.asker,
      });
      return out.ok
        ? { ok: true, value: { fixId: out.fixId, code: out.code, messageId: out.messageId } }
        : out;
    }
    case 'record': {
      const { action: _, ...request } = input;
      const out = await proposeRecord(room, request);
      // nothing is filed yet: the asker confirms in the thread, and the session is told the key
      return out.ok
        ? { ok: true, value: { pending: true, code: out.code, messageId: out.messageId } }
        : out;
    }
  }
}
