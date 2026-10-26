// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule.

import type { SupportRecordKind } from '@forge/contracts/support';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import { sessionCaller } from './access.js';
import { settleLatency } from './delivery.js';
import type { Outcome } from './outcome.js';
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
): Promise<Outcome<unknown>> {
  const room = await sessionCaller(caller);
  const out = await act(room, input);
  // the session's first post in a thread answers every message of it the session had been handed
  if (out.ok && 'thread' in input && POSTS.has(input.action)) {
    await settleLatency(room.id, input.thread, new Date());
  }
  return out;
}

/** The acts that post in the thread they name. */
const POSTS = new Set<SupportActInput['action']>(['reply', 'run', 'propose_fix', 'record']);

async function act(room: RoomRow, input: SupportActInput): Promise<Outcome<unknown>> {
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
