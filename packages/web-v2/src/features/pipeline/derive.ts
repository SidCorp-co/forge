import type { SemanticTone } from "@/design/status";
import { STALLED_THRESHOLD_MS } from "@/features/sessions/types";
import { formatElapsed } from "@/lib/utils/format";
import type { HeldIssue, Holder, LiveSession, PersonOwes } from "./types";

/** A running session silent past this reads as quiet, the same threshold the sessions list uses. */
export const QUIET_AFTER_MS = STALLED_THRESHOLD_MS;

const KIND_LABEL: Record<string, string> = {
  master: "Master",
  run_session: "Agent",
  pipeline: "Pool agent",
  pm: "PM",
};

/** What kind of session this is, in a person's word; an unknown kind is printed as core sent it. */
export function sessionKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** The session's name: its title where it has one, else its kind. */
export function sessionName(session: Pick<LiveSession, "kind" | "title">): string {
  return session.title?.trim() || sessionKindLabel(session.kind);
}

export interface Doing {
  label: string;
  tone: SemanticTone;
}

const RUNTIME_DOING: Record<string, Doing> = {
  starting: { label: "Starting", tone: "neutral" },
  working: { label: "Working", tone: "active" },
  awaiting_input: { label: "Waiting for input", tone: "attention" },
  checkpointing: { label: "Checkpointing", tone: "neutral" },
  closed: { label: "Closing", tone: "neutral" },
};

/** What the session is doing, from its status first and its runtime state second. */
export function doingOf(session: Pick<LiveSession, "status" | "runtimeState">): Doing {
  if (session.status === "queued") return { label: "Waiting for a box", tone: "neutral" };
  if (session.status === "idle") return { label: "Not started", tone: "neutral" };
  const runtime = session.runtimeState ? RUNTIME_DOING[session.runtimeState] : undefined;
  return runtime ?? { label: "Working", tone: "active" };
}

const BLOCKER: Record<string, string> = {
  human: "A person",
  machine: "A machine",
  master_or_peer: "Another agent",
  nobody: "Nobody — it stopped with a reason",
};

/** Who can end the wait and what it waits on, where the box reports the session blocked. */
export function waitingOnOf(session: Pick<LiveSession, "report">): string | null {
  const report = session.report;
  if (report?.work !== "blocked") return null;
  const who = report.blockerKind ? (BLOCKER[report.blockerKind] ?? report.blockerKind) : "Unnamed";
  return report.waitingOn ? `${who} — ${report.waitingOn}` : who;
}

export interface CheckIn {
  text: string;
  quiet: boolean;
}

/** How long ago the session last checked in, and whether a running one has gone quiet. */
export function checkInOf(
  session: Pick<LiveSession, "status" | "lastHeartbeatAt">,
  now: number,
): CheckIn {
  const at = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Number.NaN;
  if (Number.isNaN(at)) {
    return { text: "No check-in yet", quiet: session.status === "running" };
  }
  const since = Math.max(0, now - at);
  const quiet = session.status === "running" && since > QUIET_AFTER_MS;
  return { text: `${formatElapsed(since)} ago`, quiet };
}

export interface OrderedSession {
  session: LiveSession;
  /** 1 for a session listed under the master that owns it. */
  depth: 0 | 1;
}

/** Masters first, each followed by the sessions it owns; then every other session, oldest first. */
export function orderSessions(sessions: readonly LiveSession[]): OrderedSession[] {
  const byAge = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const masters = byAge.filter((s) => s.kind === "master");
  const masterIds = new Set(masters.map((m) => m.id));
  const out: OrderedSession[] = [];
  for (const m of masters) {
    out.push({ session: m, depth: 0 });
    for (const child of byAge) {
      if (child.parentSessionId === m.id) out.push({ session: child, depth: 1 });
    }
  }
  for (const s of byAge) {
    if (s.kind !== "master" && !(s.parentSessionId && masterIds.has(s.parentSessionId))) {
      out.push({ session: s, depth: 0 });
    }
  }
  return out;
}

export interface HolderLine {
  who: string;
  why: string;
  since: string;
}

const OWES: Record<PersonOwes, string> = {
  information: "A person owes information",
  decision: "A person owes a decision",
  resource: "A person owes a resource",
};

function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : `${formatElapsed(Math.max(0, now - at))} ago`;
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** One holder of an issue, as three short lines: who holds it, why, and since when. */
export function holderLine(holder: Holder, now: number): HolderLine {
  switch (holder.by) {
    case "session":
      return {
        who: `${holder.sessionTitle?.trim() || sessionKindLabel(holder.sessionKind)} on ${holder.deviceName ?? "an unnamed box"}`,
        why: "A live session is working it",
        since: ago(holder.since, now) ?? "Start not recorded",
      };
    case "claim": {
      const until = clock(holder.expiresAt);
      return {
        who: until ? `Claim by ${holder.holder} until ${until}` : `Claim by ${holder.holder}`,
        why: holder.next ?? "No next step was recorded",
        since: holder.renewedAt ? `Renewed ${ago(holder.renewedAt, now) ?? "at an unreadable time"}` : "Renewal not recorded",
      };
    }
    case "person":
      return {
        who:
          holder.status === "on_hold"
            ? "Paused by a person"
            : holder.owes
              ? OWES[holder.owes]
              : "A person — what is owed was not recorded",
        why: holder.why ?? "No reason was recorded",
        since: ago(holder.since, now) ?? "Start not recorded",
      };
  }
}

/** When the hold began, for ordering; a claim's renewal stands in for a start it never recorded. */
function startOf(holder: Holder): number {
  const iso = holder.by === "claim" ? holder.renewedAt : holder.since;
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** Issues a person holds first — they wait on someone — then the longest held first. */
export function orderHolds(holds: readonly HeldIssue[]): HeldIssue[] {
  const byPerson = (h: HeldIssue) => (h.holders.some((x) => x.by === "person") ? 0 : 1);
  const oldest = (h: HeldIssue) => Math.min(...h.holders.map(startOf));
  return [...holds].sort(
    (a, b) => byPerson(a) - byPerson(b) || oldest(a) - oldest(b) || a.displayId.localeCompare(b.displayId),
  );
}

/** The clock time a reading was taken, for the line a failed refresh shows. */
export function readAtLine(readAt: string): string {
  return `Could not refresh — showing what was read at ${clock(readAt) ?? readAt}.`;
}
