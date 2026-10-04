"use client";

// The small marks the onboarding thread and the questionnaire share: a hover note with rich
// content (the evidence behind "Why we ask"), the thread status chip, and the design chips.

import type { OnboardingStatus } from "@forge/contracts/onboarding";
import type { IssueStatusTone } from "@forge/contracts/issue-vocabulary";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, ToneBadge } from "@/design";

/** A dotted-underline word whose tooltip carries a sentence and its evidence. */
export function HoverNote({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`cursor-help whitespace-nowrap underline decoration-dotted decoration-[color:var(--border-strong)] underline-offset-[3px] ${className ?? ""}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="top" className="block max-w-[280px] whitespace-normal text-left text-[11.5px] leading-[1.45]">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

const TONE_GLYPH: Record<IssueStatusTone, string> = {
  neutral: "○",
  ready: "✓",
  run: "•",
  you: "?",
  blocked: "■",
  done: "✓",
  err: "!",
};

/** A legend-toned mark with its own words ("New", "Open", "As-built"): the shared ToneBadge. */
export function ToneChip({
  tone,
  label,
  title,
  glyph,
}: {
  tone: IssueStatusTone;
  label: string;
  title?: string;
  glyph?: string;
}) {
  return <ToneBadge tone={tone} label={label} glyph={glyph ?? TONE_GLYPH[tone]} title={title ?? label} />;
}

export function ThreadStatusChip({ status }: { status: OnboardingStatus }) {
  return <StatusBadge family="thread" value={status} />;
}

export function DesignStatusChip({ status }: { status: string | null }) {
  return status ? <StatusBadge family="design" value={status} /> : <ToneChip tone="neutral" label="Not a design" />;
}

/** The agent's own marks: Inferred beside a default it read from the code, New on a question it just raised. */
export function AiMark({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-[3px] whitespace-nowrap text-[10px] font-semibold text-[color:var(--ai-fg)] before:size-[5px] before:rounded-full before:bg-[color:var(--ai-bar)] before:content-['']"
    >
      {children}
    </span>
  );
}
