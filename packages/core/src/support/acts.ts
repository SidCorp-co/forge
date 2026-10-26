// The session's acts, each behind the check that the caller is the room's own session: the one
// function both doors (REST and the `forge_support` tool) call, so neither re-implements a rule.

import type { SupportRecordKind } from '@forge/contracts/support';
import type { SupportCallArgs } from '../integrations/support-api/index.js';
import { sessionCaller } from './access.js';
import { proposeFix } from './fixes.js';
import type { Outcome } from './outcome.js';
import { record } from './record.js';
import { search } from './search.js';
import { listTools, readThread, reply, runDiagnose } from './service.js';

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
    };

export async function supportAct(
  caller: SupportCaller,
  input: SupportActInput,
): Promise<Outcome<unknown>> {
  const room = await sessionCaller(caller);
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
    case 'record':
      return record(room, input);
  }
}
