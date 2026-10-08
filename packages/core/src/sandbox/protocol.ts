// The messages between the host (`run.ts`) and the worker that holds the isolate
// (`worker-entry.ts`). Every value is plain data and every script value crosses as a JSON string.

/** What the worker is started with. */
export interface WorkerStart {
  script: string;
  /** JSON text of the schedule's params, frozen inside the isolate as ctx.params. */
  paramsJson: string;
  /** JSON text of the input frames, frozen inside the isolate as ctx.inputs. */
  inputsJson: string;
  projectId: string;
  /** Epoch ms past which the interrupt handler stops the script. */
  deadline: number;
  wallMs: number;
  memoryMb: number;
  stackBytes: number;
  /** The most characters of ctx.log output kept; past it the log says it was cut. */
  logChars: number;
  /** The most ctx.notify calls kept; past it the call throws, naming the cap. */
  notifyCap: number;
}

export interface ScriptNotice {
  title: string;
  body?: string;
  severity?: string;
}

/** The caps a run can stop at, each naming itself. */
export type ScriptStop = 'wallMs' | 'memoryMb';

/** Worker → host: a read the script asked for through ctx.forge.get. */
export interface ReadAsk {
  type: 'read';
  id: number;
  method: string;
  path: string;
}

/**
 * Host → worker: the read's answer, as the JSON text handed into the script: `{ ok: true, body }`,
 * or `{ ok: false, name, code?, status?, message }` which the script sees as a rejected Error.
 */
export interface ReadAnswer {
  type: 'read-answer';
  id: number;
  envelope: string;
}

/** Worker → host: how the run ended. */
export interface WorkerDone {
  type: 'done';
  ok: boolean;
  /** JSON text of what the script returned, or null where it returned nothing or failed. */
  valueJson: string | null;
  output: string;
  notifications: ScriptNotice[];
  error: { name: string; message: string } | null;
  stopped: ScriptStop | null;
}

export type WorkerMessage = ReadAsk | WorkerDone;
