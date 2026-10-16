import { BLOCKED_TONE, BLOCKED_WORD, lastReported, type SemanticTone, WORKING_WORD } from "@/design/status";
import { STALLED_THRESHOLD_MS, sessionSilence, sessionTitle } from "@/features/sessions/types";
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

/** The session's name: its title where it has one, its step kind in words, else its kind. */
export function sessionName(
  session: Pick<LiveSession, "kind" | "title" | "jobType" | "skillName">,
): string {
  const title = sessionTitle({
    title: session.title,
    metadata: { jobType: session.jobType, skillName: session.skillName },
  });
  return title?.trim() || sessionKindLabel(session.kind);
}

export interface Doing {
  label: string;
  tone: SemanticTone;
}

const RUNTIME_DOING: Record<string, Doing> = {
  starting: { label: "Starting", tone: "neutral" },
  working: { label: WORKING_WORD, tone: "active" },
  awaiting_input: { label: "Waiting for input", tone: "attention" },
  checkpointing: { label: "Checkpointing", tone: "neutral" },
  closed: { label: "Closing", tone: "neutral" },
};

const BLOCKED: Doing = { label: BLOCKED_WORD, tone: BLOCKED_TONE };

/** What the session is doing, from its status first, then the box's report of a block, then its
 *  runtime state. A running session gone quiet is doing nothing anyone has heard of, so it says what
 *  it last reported instead. */
export function doingOf(
  session: Pick<LiveSession, "status" | "runtimeState" | "lastHeartbeatAt" | "startedAt"> &
    Partial<Pick<LiveSession, "report">>,
  now: number,
): Doing {
  if (session.status === "queued") return { label: "Waiting for a box", tone: "neutral" };
  if (session.status === "idle") return { label: "Not started", tone: "neutral" };
  const runtime = session.runtimeState ? RUNTIME_DOING[session.runtimeState] : undefined;
  const doing = session.report?.work === "blocked" ? BLOCKED : (runtime ?? { label: WORKING_WORD, tone: "active" });
  return isQuiet(session, now) ? { label: lastReported(doing.label), tone: "neutral" } : doing;
}

function isQuiet(session: Pick<LiveSession, "status" | "lastHeartbeatAt" | "startedAt">, now: number): boolean {
  const { state } = sessionSilence(session, now);
  return state === "stale" || state === "reaping";
}

const BLOCKER: Record<string, string> = {
  human: "A person",
  machine: "A machine",
  master_or_peer: "Another agent",
  nobody: "Nobody — it stopped with a reason",
};

export interface WaitingOn {
  text: string;
  blocked: boolean;
}

/** Who can end the wait and what it waits on; a box that sent no report is said to, not read as unblocked. */
export function waitingOnOf(session: Pick<LiveSession, "report">): WaitingOn {
  const report = session.report;
  if (!report) return { text: "Not reported by the box", blocked: false };
  if (report.work !== "blocked") return { text: "Nothing", blocked: false };
  const who = report.blockerKind ? (BLOCKER[report.blockerKind] ?? report.blockerKind) : "Unnamed";
  return { text: report.waitingOn ? `${who} — ${report.waitingOn}` : who, blocked: true };
}

export interface CheckIn {
  text: string;
  quiet: boolean;
}

/** How long ago the session last checked in, and whether a running one has gone quiet, judged by the
 *  one silence reading the session page and the sessions list also read. */
export function checkInOf(
  session: Pick<LiveSession, "status" | "lastHeartbeatAt" | "startedAt">,
  now: number,
): CheckIn {
  const quiet = isQuiet(session, now);
  const at = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : Number.NaN;
  if (Number.isNaN(at)) return { text: "No check-in yet", quiet };
  return { text: `${formatElapsed(Math.max(0, now - at))} ago`, quiet };
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

/** Why a session holds an issue: what that session is doing, in its Live sessions row's words, and
 *  for a quiet one how long it has been unheard. A session the read did not return claims nothing. */
function sessionWhy(session: LiveSession | undefined, now: number): string {
  if (!session) return "What its session is doing was not read";
  const doing = doingOf(session, now).label;
  const checkIn = checkInOf(session, now);
  return checkIn.quiet ? `${doing} · ${checkIn.text}` : doing;
}

/** One holder of an issue, as three short lines: who holds it, why, and since when. `sessions` is the
 *  same read's live sessions, which a session holder is said through. */
export function holderLine(holder: Holder, now: number, sessions: readonly LiveSession[] = []): HolderLine {
  switch (holder.by) {
    case "session":
      return {
        who: `${holder.sessionTitle?.trim() || sessionKindLabel(holder.sessionKind)} on ${holder.deviceName ?? "an unnamed box"}`,
        why: sessionWhy(
          sessions.find((s) => s.id === holder.sessionId),
          now,
        ),
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
