import { RUN_GROUP_LABELS, RUN_GROUPS, RUN_LANES, type RunActor, type RunLane, type RunNone } from "@forge/contracts/run-standing";
import type { BannerTone, ListGroup, WaitingOnView } from "@/design";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { formatCountdown, formatRelativeTime, formatStamp } from "@/lib/utils/format";
import type { RunStanding } from "./types";

export const GROUP_MODES = ["attention", "lane", "box"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/** A run's key in the list: its issue and attempt, else its release, deploy or job subject. */
export function runKey(r: Pick<RunStanding, "issue" | "attempt" | "lane" | "release" | "deployLocks" | "job" | "id">): string {
  if (r.issue) return r.attempt.source === "runs" ? `${r.issue.key} #${r.attempt.n}` : r.issue.key;
  if (r.release?.version) return r.release.version;
  if (r.deployLocks[0]) return r.deployLocks[0].environment;
  if (r.job) return enumLabel("jobType", r.job.type);
  return r.id.slice(0, 8);
}

/** "Run #4 · ISS-1402", or the run's own title where it carries no issue. */
export const runName = (r: RunStanding) =>
  r.issue && r.attempt.source === "runs" ? `Run #${r.attempt.n} · ${r.issue.key}` : r.title;

export const stepLabel = (r: Pick<RunStanding, "step">) => (r.step.step ? enumLabel("step", r.step.step) : null);

/** When the holder's lease ends, as a countdown, or that it already has. */
export function leaseLeft(r: Pick<RunStanding, "holder">): string | null {
  const h = r.holder;
  if (h.source !== "held" || !h.expiresAt) return null;
  const ms = new Date(h.expiresAt).getTime() - Date.now();
  return ms > 0 ? `expires ${formatCountdown(h.expiresAt)}` : `expired ${formatRelativeTime(h.expiresAt)}`;
}

/** Core's waiting-on, a gate named by its label and its deadline drawn as a countdown. */
export function waitingView(r: RunStanding): WaitingOnView {
  const w = r.waitingOn;
  if (w.kind === "gate") {
    const act = w.resumesAt ? `resumes ${formatCountdown(w.resumesAt)}` : "resumes itself, no deadline";
    return { kind: "gate", who: enumLabel("runGate", w.gate), act, rule: w.rule };
  }
  if (w.kind === "run") return { ...w, act: [w.act, leaseLeft(r)].filter(Boolean).join(" · ") };
  return w;
}

/** Who an outcome names: the person, else the kind of actor; null where core recorded none. */
export const actorName = (by: RunActor | RunNone): string | null =>
  "type" in by ? (by.name ?? enumLabel("runActorType", by.type)) : null;

/** The tinted line at the top of a run's peek and page: its state, and what decides the next move. */
export function runBanner(r: RunStanding): { tone: BannerTone; head: string; body: string; detail: string | null; rule: string } {
  const label = statusReading("runStanding", r.state).label;
  const stuck = r.stuck.source === "stuck" ? r.stuck : null;
  if (stuck) {
    return { tone: "err", head: `${label} ·`, body: stuck.detail, detail: stuck.failsBy, rule: `${stuck.rule}: ${r.rule}` };
  }
  const o = r.outcome;
  if (o?.kind === "failed") {
    return { tone: "err", head: `${label} ·`, body: enumLabel("failureCause", o.cause), detail: o.detail, rule: r.rule };
  }
  if (o?.kind === "cancelled") {
    const by = actorName(o.by);
    return { tone: "calm", head: `${label} ·`, body: by ? `by ${by}` : r.rule, detail: "type" in o.by ? o.by.reason : null, rule: r.rule };
  }
  if (o?.kind === "handed_back") return { tone: "calm", head: `${label} ·`, body: o.detail, detail: null, rule: r.rule };
  if (o?.kind === "done") return { tone: "calm", head: `${label} ·`, body: r.rule, detail: null, rule: r.rule };
  const w = waitingView(r);
  if (w.kind === "you" || w.kind === "person") {
    return { tone: "you", head: w.kind === "you" ? "Waiting on you ·" : `Waiting on ${w.who} ·`, body: w.act, detail: w.rule ?? null, rule: r.rule };
  }
  if (w.kind === "gate") return { tone: "blocked", head: `${label} ·`, body: `${w.who}, ${w.act}`, detail: null, rule: r.rule };
  const beat = r.lastBeatAt ? `beat ${formatRelativeTime(r.lastBeatAt)}` : null;
  const step = stepLabel(r);
  const body = [step ? `step ${step}` : null, beat].filter(Boolean).join(" · ") || r.rule;
  return { tone: r.state === "queued" ? "calm" : "run", head: `${label} ·`, body, detail: null, rule: r.rule };
}

const laneLabel = (l: RunLane) => (l === "job" ? "Jobs" : l === "issue" ? "Issue runs" : enumLabel("runLane", l));

/** The list's groups under one grouping: core's attention groups in core's order, or by lane or box. */
export function runGroups(rows: readonly RunStanding[], mode: GroupMode): ListGroup<RunStanding>[] {
  if (mode === "lane") {
    return RUN_LANES.map((l) => ({ id: l, label: laneLabel(l), tone: "neutral" as const, rows: rows.filter((r) => r.lane === l) }));
  }
  if (mode === "box") {
    const boxes = [...new Set(rows.map((r) => r.device?.name ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    return boxes.map((b) => ({
      id: `box:${b}`,
      label: b || "No box yet",
      mono: b !== "",
      tone: "neutral" as const,
      rows: rows.filter((r) => (r.device?.name ?? "") === b),
    }));
  }
  return RUN_GROUPS.map((g) => ({ id: g, ...RUN_GROUP_LABELS[g], rows: rows.filter((r) => r.attentionGroup === g) }));
}

export const stamp = (iso: string | null) => (iso ? formatStamp(iso) : "—");

export const fmtTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
