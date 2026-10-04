"use client";

// Whose turn it is, said the same way on every list and page: a mark for who, their name in bold,
// and what they owe; the rule that put it there rides the tooltip. The banner is the same fact as
// one tinted line at the top of a detail page.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { AGENT_TINT } from "../status";
import { LEGEND, type LegendTone } from "../vocabulary";
import { WhoMark, type WhoKind } from "./person-chip";

export interface WaitingOnView {
  /** `you` is the viewer; `agent` a master, assistant or run; `issue` another issue or contract;
   *  `project` another project in an ecosystem; `none` nobody (done, or no owner). */
  kind: WhoKind | "none";
  who: string;
  act: string;
  rule?: string;
}

export interface WaitingOnProps {
  w: WaitingOnView;
  /** Drawn in place of `who` when it names something the reader can open (an issue key). */
  whoNode?: ReactNode;
}

export function WaitingOn({ w, whoNode }: WaitingOnProps) {
  if (w.kind === "none") {
    return (
      <span className="truncate text-12-5 text-subtle" title={w.rule} data-testid="waiting-on" data-kind="none">
        {w.act ? `${w.who} · ${w.act}` : w.who}
      </span>
    );
  }
  const you = w.kind === "you";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12-5"
      style={{ color: you ? LEGEND.you.fg : "var(--fg-muted)" }}
      title={w.rule}
      data-testid="waiting-on"
      data-kind={w.kind}
    >
      <WhoMark kind={w.kind} who={w.who} />
      <span className="truncate">
        <b className="font-semibold" style={{ color: you ? LEGEND.you.fg : "var(--fg-default)" }}>
          {whoNode ?? w.who}
        </b>
        {w.act ? ` · ${w.act}` : null}
      </span>
    </span>
  );
}

export type BannerTone = LegendTone | "agent" | "calm";

const bannerColours = (t: BannerTone) =>
  t === "calm" ? { bg: "var(--bg-sunken)", dot: "var(--ink-400)" } : t === "agent" ? AGENT_TINT : LEGEND[t];

export interface WaitBannerProps {
  tone: BannerTone;
  /** "Waiting on you:", "Waiting on machine:", "Stuck:" — the bold lead. */
  head: string;
  body: ReactNode;
  rule?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

/** A single tinted line, never a box: whom it waits on and for what. */
export function WaitBanner({ tone, head, body, rule, children, className, testId }: WaitBannerProps) {
  const c = bannerColours(tone);
  return (
    <div className={cn("flex items-start gap-2.5 px-3 py-[9px] text-13", className)} style={{ background: c.bg }} data-testid={testId ?? "wait-banner"} title={rule}>
      <span aria-hidden className="mt-1.5 size-2 flex-none rounded-full" style={{ background: c.dot }} />
      <div className="min-w-0 flex-1">
        <span className="font-bold">{head}</span> {body}
        {children ? <span className="mt-1 block">{children}</span> : null}
      </div>
    </div>
  );
}
