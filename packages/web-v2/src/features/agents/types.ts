// cm:edge contract -> packages/core/src/devices/run-ledger.ts — `ProjectRunSessionRow` is the other half of every field below, and the box that feeds it is `transport/session_ledger.rs`; a field renamed on either side arrives here as `undefined` with no type error, because JSON.

/** The two axes, typed separately because that is the whole point of them. */
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/runner/ledger.rs — `Incarnation::wire` and `Work::wire` produce these strings; a value added there arrives here as an unknown and must widen this union rather than being folded into a neighbour.
export type Incarnation = "live" | "starting" | "exited";
export type Work = "runnable" | "blocked" | "done";
export type BlockerKind = "machine" | "master_or_peer" | "human" | "nobody";

export interface RunIssue {
  issueKey: string;
  leaseReturned: boolean;
}

export interface RunSessionRow {
  runId: string;
  projectId: string;
  sessionId: string | null;
  masterSessionId: string | null;
  pid: number | null;
  worktreePath: string;
  bootId: string;
  incarnation: Incarnation | string;
  work: Work | string;
  blockerKind: BlockerKind | string | null;
  waitingOn: string | null;
  /** The three close-loop marks, which are three and not one flag. */
  sessionTerminalAt: string | null;
  worktreeGoneAt: string | null;
  issues: RunIssue[];
  deviceId: string;
  deviceName: string | null;
  observedAt: string;
  /** Core's own reading, never the box's claim — the two disagreeing is signal. */
  sessionStatus: string | null;
  lastActivityAt: string | null;
  masterTitle: string | null;
}

export interface RunSessionsResponse {
  items: RunSessionRow[];
  count: number;
}
