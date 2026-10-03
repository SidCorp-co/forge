"use client";

// The small pieces every requirement surface draws from the core read model (`standing`): the state
// and verdict badges, the waiting-on cell, owner and age, the coverage marks, the lifecycle stepper,
// the revisions timeline and the waiting-on banner. The list row, the peek and the full page take
// the same pieces, so a value reads the same everywhere.

import {
  BC_VERDICT_HINTS,
  BC_VERDICT_LABELS,
  BC_VERDICT_TONES,
  type BcVerdict,
  REQUIREMENT_LIFECYCLE,
  REQUIREMENT_STATE_GLYPHS,
  REQUIREMENT_STATE_HINTS,
  REQUIREMENT_STATE_LABELS,
  REQUIREMENT_STATE_TONES,
  type RequirementCoverage,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingOn,
  type StandingTone,
} from "@forge/contracts/requirements";
import type { ReactNode } from "react";
import { AGENT_TINT, Icon, STATUS_META, StatusChip, Tooltip } from "@/design";
import { TONE_CHIP } from "@/features/issues/derive";
import { cn } from "@/lib/utils/cn";
import type { RequirementBaseline, RequirementRevision } from "../types";

const hintOf = (h: string) => h.replace(/^[a-z_]+: /, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "1h", "3d", "5w": the compact age a list cell carries; the absolute time rides the tooltip. */
export function ageOf(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 14) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (86_400 * 7))}w`;
}

export const stamp = (iso: string) => new Date(iso).toLocaleString();

/** A legend tone's colours, read from the design kit through the issue legend's chip. */
export const toneOf = (tone: StandingTone) => STATUS_META[TONE_CHIP[tone]];

/** One enum value as the design kit's chip: glyph and sentence-case label; the raw value and its meaning in the tooltip. */
function EnumChip({ tone, glyph, label, value, hint }: { tone: StandingTone; glyph: string; label: string; value: string; hint: string }) {
  return (
    <span className="inline-flex cursor-help" data-value={value}>
      <StatusChip size="sm" status={TONE_CHIP[tone]} glyph={glyph} label={label} title={`${value} · ${cap(hint)}`} />
    </span>
  );
}

export const StateBadge = ({ state }: { state: RequirementState }) => (
  <EnumChip
    tone={REQUIREMENT_STATE_TONES[state]}
    glyph={REQUIREMENT_STATE_GLYPHS[state]}
    label={REQUIREMENT_STATE_LABELS[state]}
    value={state}
    hint={hintOf(REQUIREMENT_STATE_HINTS[state])}
  />
);

const VERDICT_GLYPH: Record<BcVerdict, string> = {
  passing: "✓",
  failing: "×",
  stale: "↻",
  not_judged: "○",
  gap: "!",
};

export const VerdictBadge = ({ verdict }: { verdict: BcVerdict }) => (
  <EnumChip
    tone={BC_VERDICT_TONES[verdict]}
    glyph={VERDICT_GLYPH[verdict]}
    label={BC_VERDICT_LABELS[verdict]}
    value={verdict}
    hint={hintOf(BC_VERDICT_HINTS[verdict])}
  />
);

/** A person's initial in a round mark, or an icon for an agent, the system or a set of issues. */
export function WhoMark({ kind, who, size = 15 }: { kind: string; who: string; size?: number }) {
  const base = "inline-grid flex-none place-items-center font-bold not-italic leading-none";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.57) };
  if (kind === "you")
    return (
      <span aria-hidden className={cn(base, "rounded-full text-on-accent")} style={{ ...style, background: toneOf("you").dot }}>
        {who.charAt(0).toUpperCase()}
      </span>
    );
  if (kind === "person")
    return (
      <span aria-hidden className={cn(base, "rounded-full bg-[var(--ink-600)] text-surface")} style={style}>
        {who.charAt(0).toUpperCase()}
      </span>
    );
  if (kind === "agent")
    return (
      <span aria-hidden className={cn(base, "rounded-[4px]")} style={{ ...style, background: AGENT_TINT.bg, color: AGENT_TINT.fg }}>
        <Icon name="agent" size={Math.round(size * 0.68)} />
      </span>
    );
  if (kind === "system" || kind === "issues")
    return (
      <span aria-hidden className={cn(base, "rounded-[4px] bg-[var(--slate-50)] text-[var(--slate-600)]")} style={style}>
        <Icon name={kind === "issues" ? "rows" : "settings"} size={Math.round(size * 0.68)} />
      </span>
    );
  return null;
}

/** The list's "Waiting on" cell, and the same words wherever a requirement says whose turn it is. */
export function WaitingOn({ w }: { w: RequirementWaitingOn }) {
  if (w.kind === "none") {
    return (
      <span className="truncate text-12-5 text-subtle" title={w.rule}>
        {w.act ? `${w.who} · ${w.act}` : w.who}
      </span>
    );
  }
  const you = w.kind === "you";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12-5"
      style={{ color: you ? toneOf("you").fg : "var(--fg-muted)" }}
      title={w.rule}
      data-testid="waiting-on"
    >
      <WhoMark kind={w.kind} who={w.who} />
      <span className="truncate">
        <b className="font-semibold" style={{ color: you ? toneOf("you").fg : "var(--fg-default)" }}>
          {w.who}
        </b>
        {w.act ? ` · ${w.act}` : null}
      </span>
    </span>
  );
}

export function OwnerAge({ owner, at }: { owner: RequirementStanding["owner"]; at: string }) {
  return (
    <span className="inline-flex min-w-0 items-center justify-end gap-2 whitespace-nowrap">
      {owner ? (
        <span className="inline-flex min-w-0 items-center gap-[5px] text-12 text-muted">
          <span
            aria-hidden
            className="inline-grid size-5 flex-none place-items-center rounded-full bg-[var(--ink-600)] text-[9px] font-bold text-surface"
          >
            {(owner.name ?? "?").charAt(0).toUpperCase()}
          </span>
          <span className="truncate">{owner.name ?? "Unknown"}</span>
        </span>
      ) : (
        <span className="text-12 text-subtle">No owner</span>
      )}
      <span className="font-mono text-11 text-subtle" title={`Last touched ${stamp(at)}`}>
        {ageOf(at)}
      </span>
    </span>
  );
}

const VERDICT_MARK: Record<BcVerdict, string> = {
  passing: toneOf("ready").dot,
  failing: toneOf("err").dot,
  stale: "repeating-linear-gradient(135deg, var(--ink-400) 0 3px, var(--paper-400) 3px 6px)",
  not_judged: "var(--paper-400)",
  gap: toneOf("you").dot,
};

/** One mark per business criterion, coloured by its verdict; the code, verdict and wording on hover. */
export function CoverageMarks({ coverage, large, labelled }: { coverage: RequirementCoverage[]; large?: boolean; labelled?: boolean }) {
  if (coverage.length === 0) return <span className="text-12 text-subtle">No criteria yet</span>;
  return (
    <span className={cn("inline-flex flex-wrap items-center", labelled ? "gap-2.5" : "gap-0.5")} role="img" aria-label="Coverage by business criterion">
      {coverage.map((c) => (
        <Tooltip key={c.code} label={`${c.code} · ${BC_VERDICT_LABELS[c.verdict]} — ${c.body}`} multiline>
          <span className="inline-flex flex-col items-center gap-[3px]">
            <span
              className="block rounded-[2px]"
              style={{ width: large ? 28 : 16, height: large ? 12 : 10, background: VERDICT_MARK[c.verdict] }}
            />
            {labelled ? <span className="font-mono text-11 text-subtle">{c.code}</span> : null}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

/** Draft → Agreed → In delivery → Delivered → Accepted, with the requirement's place on it. */
export function Stepper({ state }: { state: RequirementState }) {
  const at = REQUIREMENT_LIFECYCLE.indexOf(state as (typeof REQUIREMENT_LIFECYCLE)[number]);
  return (
    <ol className="flex flex-wrap items-center gap-y-2 py-1.5 text-11-5" aria-label="Lifecycle" data-testid="lifecycle">
      {REQUIREMENT_LIFECYCLE.map((s, i) => {
        const done = at >= 0 && (i < at || (i === at && s === "accepted"));
        const now = i === at && s !== "accepted";
        const tone = now ? (s === "delivered" ? toneOf("you") : toneOf("run")) : null;
        return (
          <li key={s} className="inline-flex items-center" style={{ color: tone?.fg ?? (done ? "var(--fg-muted)" : "var(--fg-subtle)") }}>
            <span
              aria-hidden
              className="mr-1.5 inline-block size-[9px] rounded-full border-2"
              style={{
                borderColor: tone?.dot ?? (done ? "var(--ink-600)" : "var(--paper-400)"),
                background: tone?.dot ?? (done ? "var(--ink-600)" : "var(--bg-surface)"),
              }}
            />
            <span className={now ? "font-semibold" : undefined}>{REQUIREMENT_STATE_LABELS[s]}</span>
            {i < REQUIREMENT_LIFECYCLE.length - 1 ? (
              <span aria-hidden className="mx-1.5 inline-block h-0.5 w-[18px]" style={{ background: done ? "var(--ink-600)" : "var(--paper-300)" }} />
            ) : null}
          </li>
        );
      })}
      {state === "dropped" ? (
        <li className="ml-2">
          <StateBadge state="dropped" />
        </li>
      ) : null}
    </ol>
  );
}

/** The revisions on a time axis: accepted ones solid, the open one as a ring, agrees marked signed. */
export function RevisionTimeline({ revisions, baselines }: { revisions: RequirementRevision[]; baselines: RequirementBaseline[] }) {
  if (revisions.length === 0) return <div className="text-12-5 text-subtle">No revision yet.</div>;
  const points = [...revisions]
    .reverse()
    .map((r) => ({ r, at: new Date(r.decidedAt ?? r.proposedAt ?? r.createdAt).getTime() }));
  const now = Date.now();
  const first = Math.min(...points.map((p) => p.at));
  const span = Math.max(now - first, 86_400_000);
  const pad = span * 0.06;
  const pct = (t: number) => `${(((t - first + pad) / (span + pad * 2)) * 100).toFixed(2)}%`;
  const agreed = new Set(baselines.map((b) => b.revision));
  return (
    <div>
      <div className="relative mx-2 mb-1 mt-1.5 h-[52px]" role="img" aria-label="Revisions">
        <div className="absolute inset-x-0 top-[14px] h-0.5 bg-[var(--paper-300)]" />
        <div className="absolute top-0.5 h-[26px] w-0 border-l border-dashed border-[var(--ink-500)]" style={{ left: pct(now) }} title={`Today, ${new Date(now).toLocaleDateString()}`} />
        {points.map(({ r, at }) => {
          const open = r.state === "draft" || r.state === "proposed";
          const label = `r${r.revision}${agreed.has(r.revision) ? " signed" : ""}`;
          return (
            <div key={r.revision} className="absolute top-2 flex -translate-x-1/2 flex-col items-center gap-[3px]" style={{ left: pct(at) }}>
              <Tooltip label={`r${r.revision} · ${cap(r.state)} · ${stamp(new Date(at).toISOString())}${r.authorName ? ` · ${r.authorName}` : ""}`} multiline>
                <span
                  className="block size-3 rounded-full border-2"
                  style={
                    open
                      ? { background: "var(--bg-surface)", borderColor: toneOf("you").dot, borderStyle: "dashed" }
                      : { background: r.state === "current" ? "var(--ink-600)" : "var(--ink-400)", borderColor: "var(--bg-surface)" }
                  }
                />
              </Tooltip>
              <span className="whitespace-nowrap text-[10.5px] font-semibold text-muted">{label}</span>
              <span className="whitespace-nowrap font-mono text-[9.5px] text-subtle">{new Date(at).toISOString().slice(5, 10)}</span>
            </div>
          );
        })}
      </div>
      <div className="text-12 text-subtle">Dashed line: today.</div>
    </div>
  );
}

const BANNER_TONE: Record<RequirementWaitingOn["kind"], StandingTone | "calm" | "agent"> = {
  you: "you",
  person: "calm",
  agent: "agent",
  issues: "run",
  none: "calm",
};

/** A single tinted line: whom it waits on and for what, the rule behind it on hover. */
export function WaitBanner({ standing, children }: { standing: RequirementStanding; children?: ReactNode }) {
  const w = standing.waitingOn;
  const toneKey = standing.attentionGroup === "stuck" && w.kind === "none" ? "you" : BANNER_TONE[w.kind];
  const c = toneKey === "calm" ? { bg: "var(--bg-sunken)", dot: "var(--ink-400)" } : toneKey === "agent" ? AGENT_TINT : toneOf(toneKey);
  const head =
    standing.attentionGroup === "done"
      ? standing.state === "accepted"
        ? "Accepted."
        : "Dropped."
      : standing.attentionGroup === "stuck" && w.kind === "none"
        ? "Stuck:"
        : `Waiting on ${w.kind === "you" ? "you" : w.who}:`;
  const body =
    standing.attentionGroup === "done"
      ? "Nothing is owed on it."
      : standing.attentionGroup === "stuck" && w.kind === "none"
        ? "no owner; someone has to take it."
        : w.act;
  return (
    <div className="mb-1 flex items-start gap-2.5 px-3 py-[9px] text-13" style={{ background: c.bg }} data-testid="wait-banner" title={w.rule}>
      <span aria-hidden className="mt-1.5 size-2 flex-none rounded-full" style={{ background: c.dot }} />
      <div className="min-w-0 flex-1">
        <span className="font-bold">{head}</span> {body}
        {children ? <span className="mt-1 block">{children}</span> : null}
      </div>
    </div>
  );
}

/** "Rev 4 · rev 5 proposed": the revision fact the row and the facts list share. */
export function revisionText(current: number | null, s: RequirementStanding): string {
  const open = s.facts.proposedRevision ?? s.facts.draftRevision;
  const head = current !== null ? `Rev ${current}` : "No accepted revision";
  if (open === null) return head;
  return `${head}${current !== null ? ", " : " · "}rev ${open} ${s.facts.proposedRevision !== null ? "proposed" : "in draft"}`;
}
