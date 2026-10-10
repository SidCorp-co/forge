import { RUN_GROUP_LABELS, RUN_GROUPS, RUN_LANES, type RunActor, type RunLane, type RunNone } from "@forge/contracts/run-standing";
import type { BannerTone, ListGroup, WaitingOnView } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatCountdown, formatRelative } from "@/lib/i18n/format";
import { copyOr, productCopy } from "@/lib/i18n/product-copy";
import { said, saidView } from "@/lib/i18n/said";
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
  r.issue && r.attempt.source === "runs" ? productCopy(language)("runs.name", { n: r.attempt.n, key: r.issue.key }) : said(r.says.title, language);

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
    return { kind: "gate", who: enumLabel("runGate", w.gate, language), act, rule: said(w.says.rule, language) };
  }
  const v = saidView(w, language);
  if (w.kind === "run") return { ...v, act: [v.act, leaseLeft(r, language)].filter(Boolean).join(" · ") };
  return v;
}

/** Who an outcome names: the person, else the kind of actor; null where core recorded none. */
export const actorName = (by: RunActor | RunNone, language = "en"): string | null =>
  "type" in by ? (by.name ?? enumLabel("runActorType", by.type, language)) : null;

/**
 * The tinted line at the top of a run's peek and page: what the header's badge does not say (REQ-43
 * BC-5) — whom it waits on and for what, why it stopped, or its last beat. `detail` is a person's
 * (the reason a cancel gave); `agent` and `rule` are core's own sentences and codes, drawn only in the
 * developer view (BC-7). An empty `body` says nothing the page lacks, so no line is drawn.
 */
export function runBanner(r: RunStanding, language = "en"): { tone: BannerTone; head: string; body: string; detail: string | null; agent: string | null; rule: string } {
  const t = productCopy(language);
  const stuck = r.stuck.source === "stuck" ? r.stuck : null;
  const rule = said(r.says.rule, language);
  if (stuck) return { tone: "err", head: "", body: said(stuck.says.detail, language), detail: null, agent: said(stuck.says.failsBy, language), rule: `${stuck.rule}: ${rule}` };
  const o = r.outcome;
  if (o?.kind === "failed") return { tone: "err", head: "", body: enumLabel("failureCause", o.cause, language), detail: null, agent: o.detail, rule };
  if (o?.kind === "cancelled") {
    const by = actorName(o.by, language);
    return { tone: "calm", head: "", body: by ? t("runs.byWhoCap", { who: by }) : "", detail: "type" in o.by ? o.by.reason : null, agent: null, rule };
  }
  if (o?.kind === "handed_back") return { tone: "calm", head: "", body: said(o.says.detail, language), detail: null, agent: null, rule };
  if (o?.kind === "done") return { tone: "calm", head: "", body: t("runs.banner.nothingOwed"), detail: null, agent: null, rule };
  const w = waitingView(r, language);
  if (w.kind === "you" || w.kind === "person") {
    return { tone: "you", head: w.kind === "you" ? t("runs.waitingOnYou") : t("runs.waitingOnWho", { who: w.who }), body: w.act, detail: null, agent: w.rule ?? null, rule };
  }
  if (w.kind === "gate") return { tone: "blocked", head: "", body: `${w.who}, ${w.act}`, detail: null, agent: null, rule };
  // the run holding itself names its step and lease, which the facts rail says: the banner says its last beat
  const beat = r.lastBeatAt ? t("runs.lastBeat", { when: formatRelative(r.lastBeatAt, language) }) : "";
  const body = w.kind === "none" || w.kind === "run" ? beat : [`${w.who} · ${w.act}`, beat].filter(Boolean).join(" · ");
  return { tone: r.state === "queued" ? "calm" : "run", head: "", body, detail: null, agent: null, rule };
}

const laneLabel = (l: RunLane, language: string) => (l === "job" ? productCopy(language)("runs.lane.jobs") : l === "issue" ? productCopy(language)("runs.lane.issueRuns") : enumLabel("runLane", l, language));

/** A run attention group's label in `language`; a group this build does not know reads as its id. */
export const attentionGroupText = (g: string, language: string) => ({
  label: copyOr(language, `runs.attention.${g}.label`, g),
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

