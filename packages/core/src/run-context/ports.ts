import { portSlot } from '../lib/port-slot.js';

/** The box credential a read was made with, and the run it names, if it names one. */
export interface RunCaller {
  deviceId: string;
  /** The projects the credential is fenced to; null where it names none. */
  fence: readonly string[] | null;
  /** The project the read is in. */
  projectId: string;
  /** The run the call names by `x-forge-run`; null where it names none. */
  asked: string | null;
}

/** The run a call was made in, or why none could be named. */
export type CallRun =
  | { ok: true; sessionId: string; issueIds: readonly string[] }
  | { ok: false; reason: string };

/**
 * What run-context reaches but does not own. Sessions, jobs and declared runs sit downstream
 * (Execution after Knowledge), so run-context names what it needs and the composition root fills it.
 */
export interface RunContextPorts {
  /** The one run a box credential's read was made in: the run it names, else the box's one live session in the project. */
  runOfCall(caller: RunCaller): Promise<CallRun>;
}

const slot = portSlot<RunContextPorts>('run-context', 'provideRunContextPorts');
export const provideRunContextPorts = slot.provide;
export const runContextPort = slot.port;
