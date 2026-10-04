// What the agent-sessions kernel needs from the modules above it, handed in by the process entry at
// boot (ADR 0008: a kernel imports only kernel and platform modules, never an adapter). Read only
// inside a call, never at import.

import type { ContentLanguageView } from '@forge/contracts/content-language';
import type { KernelExecutor } from '../db/kernel-marker.js';
import type { EgressScope } from '../lib/data-egress.js';
import type { KernelActor } from '../lifecycle/index.js';

/** The blob store attachment bytes live in. */
export interface AttachmentStore {
  get(path: string): Promise<Buffer>;
  put(key: string, bytes: Buffer, mime: string): Promise<{ path: string }>;
}

/** A completed session a schedule started, as the schedule's write-back reads it. */
export interface CompletedScheduleSession {
  id: string;
  metadata: unknown;
  messages: unknown;
}

export interface AgentSessionsPorts {
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
  /** Writes a completed schedule session's report back onto its schedule and session. */
  writeBackScheduleSession(session: CompletedScheduleSession): Promise<void>;
  /** Re-dispatches a schedule's session on another box after a failover-class failure. */
  redispatchScheduleSessionOnFailover(
    sessionId: string,
    opts?: { failureClass?: string | null },
  ): Promise<{ ok: boolean; status: string }>;
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
