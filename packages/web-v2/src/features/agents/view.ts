import { RUN_GROUP_LABELS, RUN_GROUPS, RUN_LANES, type RunActor, type RunLane, type RunNone } from "@forge/contracts/run-standing";
import type { BannerTone, ListGroup, WaitingOnView } from "@/design";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { formatCountdown, formatDateTime, formatRelative } from "@/lib/i18n/format";
import { copyOr, productCopy } from "@/lib/i18n/product-copy";
import { standingAct, standingWho } from "@/lib/i18n/standing-copy";
import type { RunStanding } from "./types";

export const GROUP_MODES = ["attention", "lane", "box"] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/** A run's key in the list: its issue and attempt, else its release, deploy or job subject. */
export function runKey(r: Pick<RunStanding, "issue" | "attempt" | "lane" | "release" | "deployLocks" | "job" | "id">, language = "en"): string {
  if (r.issue) return r.attempt.source === "runs" ? `${r.issue.key} #${r.attempt.n}` : r.issue.key;
  if (r.release?.version) return r.release.version;
  if (r.deployLocks[0]) return r.deployLocks[0].environment;
  if (r.job) return enumLabel("jobType", r.job.type, language);
  return r.id.slice(0, 8);
}

/** "Run #4 · ISS-1402", or the run's own title where it carries no issue. */
export const runName = (r: RunStanding, language = "en") =>
  r.issue && r.attempt.source === "runs" ? productCopy(language)("runs.name", { n: r.attempt.n, key: r.issue.key }) : r.title;

export const stepLabel = (r: Pick<RunStanding, "step">, language = "en") => (r.step.step ? enumLabel("step", r.step.step, language) : null);

/** When the holder's lease ends, as a countdown, or that it already has. */
export function leaseLeft(r: Pick<RunStanding, "holder">, language = "en"): string | null {
  const h = r.holder;
  if (h.source !== "held" || !h.expiresAt) return null;
  const t = productCopy(language);
  const ms = new Date(h.expiresAt).getTime() - Date.now();
  return ms > 0 ? t("runs.leaseExpires", { when: formatCountdown(h.expiresAt, language) }) : t("runs.leaseExpired", { when: formatRelative(h.expiresAt, language) });
}

/** Core's waiting-on, a gate named by its label and its deadline drawn as a countdown. */
export function waitingView(r: RunStanding, language = "en"): WaitingOnView {
  const w = r.waitingOn;
  const t = productCopy(language);
  if (w.kind === "gate") {
    const act = w.resumesAt ? t("runs.resumes", { when: formatCountdown(w.resumesAt, language) }) : t("runs.resumesItself");
    return { kind: "gate", who: enumLabel("runGate", w.gate, language), act, rule: w.rule };
  }
  if (w.kind === "run") return { ...w, act: [standingAct(w.act, language), leaseLeft(r, language)].filter(Boolean).join(" · ") };
  return w;
}

/** Who an outcome names: the person, else the kind of actor; null where core recorded none. */
export const actorName = (by: RunActor | RunNone, language = "en"): string | null =>
  "type" in by ? (by.name ?? enumLabel("runActorType", by.type, language)) : null;

/** The tinted line at the top of a run's peek and page: its state, and what decides the next move. */
export function runBanner(r: RunStanding, language = "en"): { tone: BannerTone; head: string; body: string; detail: string | null; rule: string } {
  const t = productCopy(language);
  const label = statusReading("runStanding", r.state, language).label;
  const stuck = r.stuck.source === "stuck" ? r.stuck : null;
  if (stuck) {
    return { tone: "err", head: `${label} ·`, body: stuck.detail, detail: stuck.failsBy, rule: `${stuck.rule}: ${r.rule}` };
  }
  const o = r.outcome;
  if (o?.kind === "failed") {
    return { tone: "err", head: `${label} ·`, body: enumLabel("failureCause", o.cause, language), detail: o.detail, rule: r.rule };
  }
  if (o?.kind === "cancelled") {
    const by = actorName(o.by, language);
    return { tone: "calm", head: `${label} ·`, body: by ? t("runs.byWho", { who: by }) : r.rule, detail: "type" in o.by ? o.by.reason : null, rule: r.rule };
  }
  if (o?.kind === "handed_back") return { tone: "calm", head: `${label} ·`, body: o.detail, detail: null, rule: r.rule };
  if (o?.kind === "done") return { tone: "calm", head: `${label} ·`, body: r.rule, detail: null, rule: r.rule };
  const w = waitingView(r, language);
  if (w.kind === "you" || w.kind === "person") {
    return {
      tone: "you",
      head: w.kind === "you" ? t("runs.waitingOnYou") : t("runs.waitingOnWho", { who: standingWho(w.who, language) }),
      body: standingAct(w.act, language),
      detail: w.rule ?? null,
      rule: r.rule,
    };
  }
  if (w.kind === "gate") return { tone: "blocked", head: `${label} ·`, body: `${w.who}, ${w.act}`, detail: null, rule: r.rule };
  const beat = r.lastBeatAt ? t("runs.beat", { when: formatRelative(r.lastBeatAt, language) }) : null;
  const step = stepLabel(r, language);
  const body = [step ? t("runs.stepWord", { step }) : null, beat].filter(Boolean).join(" · ") || r.rule;
  return { tone: r.state === "queued" ? "calm" : "run", head: `${label} ·`, body, detail: null, rule: r.rule };
}

const laneLabel = (l: RunLane, language: string) => (l === "job" ? productCopy(language)("runs.lane.jobs") : l === "issue" ? productCopy(language)("runs.lane.issueRuns") : enumLabel("runLane", l, language));

/** A run attention group's words in `language`; a group this build does not know reads as its id. */
export const attentionGroupText = (g: string, language: string) => ({
  label: copyOr(language, `runs.attention.${g}.label`, g),
  hint: copyOr(language, `runs.attention.${g}.hint`, ""),
});

/** The list's groups under one grouping: core's attention groups in core's order, or by lane or box. */
export function runGroups(rows: readonly RunStanding[], mode: GroupMode, language = "en"): ListGroup<RunStanding>[] {
  if (mode === "lane") {
    return RUN_LANES.map((l) => ({ id: l, label: laneLabel(l, language), tone: "neutral" as const, rows: rows.filter((r) => r.lane === l) }));
  }
  if (mode === "box") {
    const boxes = [...new Set(rows.map((r) => r.device?.name ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
    return boxes.map((b) => ({
      id: `box:${b}`,
      label: b || productCopy(language)("runs.noBoxYet"),
      mono: b !== "",
      tone: "neutral" as const,
      rows: rows.filter((r) => (r.device?.name ?? "") === b),
    }));
  }
  return RUN_GROUPS.map((g) => ({ id: g, ...attentionGroupText(g, language), tone: RUN_GROUP_LABELS[g].tone, collapsed: RUN_GROUP_LABELS[g].collapsed, rows: rows.filter((r) => r.attentionGroup === g) }));
}

export const stamp = (iso: string | null, language = "en") => (iso ? formatDateTime(iso, language) : "—");

export const fmtTime = (iso: string | null, language = "en") => (iso ? formatDateTime(iso, language) : "—");
