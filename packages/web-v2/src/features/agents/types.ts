
/** The two axes, typed separately because that is the whole point of them. */
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
  /** Why core failed the session, where it did. `null` both on a clean end and on one still open. */
  sessionFailureReason: string | null;
  lastActivityAt: string | null;
  masterTitle: string | null;
}

export interface RunSessionsResponse {
  items: RunSessionRow[];
  count: number;
}
