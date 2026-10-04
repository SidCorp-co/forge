// What the agent-sessions kernel needs from the modules above it, handed in by the process entry at
// boot (ADR 0008: a kernel imports only kernel and platform modules, never an adapter). Read only
// inside a call, never at import.

import type { ContentLanguageView } from '@forge/contracts/content-language';
import type { Tx } from '../db/client.js';
import type { KernelExecutor } from '../db/kernel-marker.js';
import type { MemberLens } from '../db/schema.js';
import type { InterventionEventInput, ResolvedJobMcpServers } from '../jobs/index.js';
import type { EgressScope } from '../lib/data-egress.js';
import type { KernelActor } from '../lifecycle/index.js';

/** The blob store attachment bytes live in. */
interface AttachmentStore {
  get(path: string): Promise<Buffer>;
  put(key: string, bytes: Buffer, mime: string): Promise<{ path: string }>;
}

interface AgentSessionsPorts {
  /** The preamble an interactive session on this project starts with. */
  buildChatPreamble(
    projectId: string,
    userId?: string | null,
    forceLenses?: readonly MemberLens[] | null,
  ): Promise<string>;
  /** The tool reference a resumed chat turn is handed as its system prompt. */
  toolReference(): string;
  attachments(): AttachmentStore;
  /** The deployment's fast model; null when none is configured or the call failed. */
  callFastModel(scope: EgressScope, prompt: string, maxTokens: number): Promise<string | null>;
  /** The characters of `rendered` in a script `source` does not license. */
  foreignScriptChars(rendered: string, source: string): string[];
  readContentLanguage(projectId: string): Promise<ContentLanguageView>;
  /** The project's registered skills after shadowing, as a session may run them. */
  resolveRegisteredEffectiveSkills(
    projectId: string,
  ): Promise<readonly { name: string; installOnly: boolean }[]>;
  /** Settles the schedule fires the ending sessions ran, inside the session move's transaction. */
  settleSessionFires(
    exec: KernelExecutor,
    args: {
      sessionIds: readonly string[];
      sessionStatus: string;
      actor: KernelActor;
      source: string;
    },
  ): Promise<void>;
  /** Re-dispatches a schedule's session on another box after a failover-class failure. */
  redispatchScheduleSessionOnFailover(
    sessionId: string,
    opts?: { failureClass?: string | null },
  ): Promise<{ ok: boolean; status: string }>;
  /** The user holding the box's live personal access token, or null when none is live. */
  deviceHolderUserId(deviceId: string): Promise<string | null>;
  /** Records an intervention on the job's event history, inside the caller's transaction. */
  insertInterventionEvent(tx: Tx, input: InterventionEventInput): Promise<void>;
  /** The MCP servers a chat turn on this project hands its box. */
  resolveSessionMcpServers(projectId: string): Promise<ResolvedJobMcpServers>;
  /** Posts the steer text as a comment on the issue the session works. */
  postSteerComment(input: {
    issueId: string;
    authorId: string;
    body: string;
  }): Promise<{ id: string }>;
}

let provided: AgentSessionsPorts | null = null;

export function provideAgentSessionsPorts(ports: AgentSessionsPorts): void {
  provided = ports;
}

export function agentSessionsPorts(): AgentSessionsPorts {
  if (!provided) {
    throw new Error(
      'agent-sessions: no ports were provided, so a session cannot reach storage, the fast model, skills, schedules or comments; the process entry calls provideAgentSessionsPorts before it serves',
    );
  }
  return provided;
}
