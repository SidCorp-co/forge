"use client";

// Whose turn it is, said the same way on every list and page: a mark for who, their name in bold,
// and what they owe; the rule that put it there rides the tooltip. The banner is the same fact as
// one tinted line at the top of a detail page.

import { WAITING_KIND_MARKS, type WaitingKind } from "@forge/contracts/standing";
import type { ReactNode } from "react";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { type SaidWait, saidView } from "@/lib/i18n/said";
import { cn } from "@/lib/utils/cn";
import { AGENT_TINT } from "../status";
import { LEGEND, type LegendTone } from "../vocabulary";
import { WhoMark } from "./person-chip";

/** Core's waiting-on (`@forge/contracts/standing:WaitingOn`); only what the cell draws is required. */
export interface WaitingOnView {
  kind: WaitingKind;
  who: string;
  act: string;
  rule?: string;
  /** What doing the act changes, in one sentence. */
  effect?: string;
  /** What core said (`@forge/contracts/said`): when present, the words are read from it in the reader's language. */
  says?: SaidWait;
}

export interface WaitingOnProps {
  w: WaitingOnView;
  /** Drawn in place of `who` when it names something the reader can open (an issue key). */
  whoNode?: ReactNode;
}

const fullText = (w: WaitingOnView) => [w.act ? `${w.who} · ${w.act}` : w.who, w.rule].filter(Boolean).join(" — ");

export function WaitingOn({ w: core, whoNode }: WaitingOnProps) {
  const w = saidView(core, useInterfaceLanguage());
  const mark = WAITING_KIND_MARKS[w.kind];
  if (mark === "none") {
    return (
      <span className="truncate text-12-5 text-subtle" title={fullText(w)} data-testid="waiting-on" data-kind="none">
        {w.act ? `${w.who} · ${w.act}` : w.who}
      </span>
    );
  }
  const you = mark === "you";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12-5"
      style={{ color: you ? LEGEND.you.fg : "var(--fg-muted)" }}
      title={fullText(w)}
      data-testid="waiting-on"
      data-kind={w.kind}
    >
      <WhoMark kind={mark} who={w.who} />
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

export const bannerColours = (t: BannerTone) =>
  t === "calm" ? { bg: "var(--bg-sunken)", dot: "var(--ink-400)" } : t === "agent" ? AGENT_TINT : LEGEND[t];

export interface WaitBannerProps {
  tone: BannerTone;
  /** "Waiting on you:", "Waiting on machine:", "Stuck:" — the bold lead. */
  head: string;
  body: ReactNode;
  rule?: string;
  /** What doing the act changes: one quieter line under the body. */
  effect?: string | undefined;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

/** A single tinted line, never a box: whom it waits on and for what. */
export function WaitBanner({ tone, head, body, rule, effect, children, className, testId }: WaitBannerProps) {
  const c = bannerColours(tone);
  return (
    <div className={cn("flex items-start gap-2.5 px-3 py-[9px] text-13", className)} style={{ background: c.bg }} data-testid={testId ?? "wait-banner"} title={rule}>
      <span aria-hidden className="mt-1.5 size-2 flex-none rounded-full" style={{ background: c.dot }} />
      <div className="min-w-0 flex-1">
        <span className="font-bold">{head}</span> {body}
        {effect ? (
          <span className="mt-0.5 block text-12-5 text-muted" data-testid="wait-effect">
            {effect}
          </span>
        ) : null}
        {children ? <span className="mt-1 block">{children}</span> : null}
      </div>
    </div>
  );
}
