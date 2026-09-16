/**
 * ISS-1051 — the trail is what the assistant left in `chat_logs` while it answered: one row per
 * call of the turn function, so a screen repair is a second row for one send and a fallback is a
 * delivered text no row carries. Rows are tied to sends by row-id boundaries the runner snapshots
 * around each send, never by matching reply text, because two sends may say the same thing.
 */

/** A `chat_logs` row as `GET /api/chat-logs` serves it; only the fields the benchmark reads are named. */
export interface ChatLogRow {
  id: string;
  sessionId: string | null;
  reply: string | null;
  toolCalls: unknown;
  iterations: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface ToolCall {
  name: string;
  arguments: string;
  /** The `forge` tool's argv, parsed from its arguments; null for every other tool. */
  argv: string[] | null;
  isError: boolean;
  durationMs: number;
}

/** One call of the turn function, as its trail row recorded it. */
export interface Attempt {
  chatLogId: string;
  calls: ToolCall[];
  iterations: number;
  ms: number;
  reply: string | null;
  error: string | null;
}

export class TrailPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrailPairingError';
  }
}

function argvOf(name: string, args: string): string[] | null {
  if (name !== 'forge') return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const argv = (parsed as { argv?: unknown }).argv;
    return Array.isArray(argv) ? argv.map((a) => String(a)) : null;
  } catch {
    return null;
  }
}

function readCall(raw: unknown): ToolCall {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const name = typeof c.name === 'string' ? c.name : '';
  const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {});
  return {
    name,
    arguments: args,
    argv: argvOf(name, args),
    isError: c.isError === true,
    durationMs: typeof c.durationMs === 'number' ? c.durationMs : 0,
  };
}

/** A chat-logs row read into the shape the graders take. */
export function readAttempt(row: ChatLogRow): Attempt {
  const calls = Array.isArray(row.toolCalls) ? row.toolCalls.map(readCall) : [];
  return {
    chatLogId: row.id,
    calls,
    iterations: row.iterations ?? 0,
    ms: row.durationMs ?? 0,
    reply: row.reply,
    error: row.error,
  };
}

/**
 * Split the room's rows among its sends. `snapshots[0]` is the ids of the room's rows before the
 * first send and `snapshots[k + 1]` the ids after send `k`; the rows new between two snapshots are
 * that send's attempts. A room row no snapshot places, or a snapshot id no row carries, is refused
 * by id: the evidence is incomplete and a guess would grade the wrong turn.
 */
export function pairTrail(roomId: string, rows: ChatLogRow[], snapshots: string[][]): Attempt[][] {
  const roomRows = rows.filter((r) => r.sessionId === roomId);
  const byId = new Map(roomRows.map((r) => [r.id, r] as const));
  const last = new Set(snapshots[snapshots.length - 1] ?? []);
  for (const row of roomRows) {
    if (!last.has(row.id))
      throw new TrailPairingError(
        `chat_logs row ${row.id} belongs to room ${roomId} but no send boundary places it`,
      );
  }
  const sends: Attempt[][] = [];
  for (let k = 1; k < snapshots.length; k += 1) {
    const before = new Set(snapshots[k - 1] ?? []);
    const attempts: Attempt[] = [];
    for (const id of snapshots[k] ?? []) {
      if (before.has(id)) continue;
      const row = byId.get(id);
      if (!row)
        throw new TrailPairingError(
          `send ${k} boundary names chat_logs row ${id}, which the trail read does not hold`,
        );
      attempts.push(readAttempt(row));
    }
    attempts.sort((a, b) => a.chatLogId.localeCompare(b.chatLogId));
    sends.push(attempts);
  }
  return sends;
}
