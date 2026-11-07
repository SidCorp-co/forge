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
  /** The names a schedule declares under ctx.ops (REQ-87 BC-1); a call of any other is still asked, and refused by the host. */
  opsNames: string[];
  /** JSON text of the schedule's state (ctx.state, REQ-87 BC-3); null where the run keeps none. */
  stateJson: string | null;
  /** The most bytes ctx.state.set takes, as JSON text. */
  stateCapBytes: number;
}

export interface ScriptNotice {
  title: string;
  body?: string;
  severity?: string;
}

/** The caps a run can stop at, each naming itself (REQ-37 BC-8). The output cap (`logChars`)
 *  stops nothing: the log says where it was cut, naming the cap. */
export type ScriptStop = 'wallMs' | 'memoryMb' | 'stackBytes';

/** Worker → host: a read the script asked for through ctx.forge.get. */
export interface ReadAsk {
  type: 'read';
  id: number;
  method: string;
  path: string;
}

/** Worker → host: an ops call the script asked for through ctx.ops.<name>(args?) (REQ-87 BC-1). */
export interface OpsAsk {
  type: 'ops';
  id: number;
  name: string;
  /** JSON text of what the script passed, `null` where it passed nothing. */
  argsJson: string;
}

/** Worker → host: a filing the script asked for through ctx.feedback.file(payload) (REQ-87 BC-2). */
export interface FileAsk {
  type: 'file';
  id: number;
  payloadJson: string;
}

/**
 * Host → worker: the answer to a read, an ops call or a filing, as the JSON text handed into the
 * script: `{ ok: true, body }`, or `{ ok: false, name, code?, status?, message }` which the script
 * sees as a rejected Error.
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
  /** JSON text of the state the script last set; null where it set none. */
  stateJson: string | null;
}

export type WorkerMessage = ReadAsk | OpsAsk | FileAsk | WorkerDone;
