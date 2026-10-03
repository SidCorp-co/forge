"use client";

// The small marks the onboarding thread and the questionnaire share: a hover note with rich
// content (the evidence behind "Why we ask"), the thread status chip, and the design chips.

import {
  ONBOARDING_STATUS_LABELS,
  ONBOARDING_STATUS_TONES,
  type OnboardingStatus,
} from "@forge/contracts/onboarding";
import type { IssueStatusTone } from "@forge/contracts/issue-vocabulary";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusChip } from "@/design";
import type { StatusKey } from "@/design/status";

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

const TONE_CHIP: Record<IssueStatusTone, StatusKey> = {
  neutral: "queued",
  ready: "passed",
  run: "running",
  you: "waiting",
  done: "archived",
  err: "failed",
};
const TONE_GLYPH: Record<IssueStatusTone, string> = {
  neutral: "○",
  ready: "✓",
  run: "•",
  you: "?",
  done: "✓",
  err: "!",
};

export function ToneChip({ tone, label, title }: { tone: IssueStatusTone; label: string; title?: string }) {
  return <StatusChip size="sm" status={TONE_CHIP[tone]} glyph={TONE_GLYPH[tone]} label={label} title={title ?? label} />;
}

export function ThreadStatusChip({ status }: { status: OnboardingStatus }) {
  return <ToneChip tone={ONBOARDING_STATUS_TONES[status]} label={ONBOARDING_STATUS_LABELS[status]} />;
}

const DESIGN_TONE: Record<string, [IssueStatusTone, string]> = {
  draft: ["neutral", "Draft"],
  proposed: ["you", "Proposed"],
  approved: ["ready", "Approved"],
  returned: ["err", "Returned"],
};

export function DesignStatusChip({ status }: { status: string | null }) {
  const [tone, label] = DESIGN_TONE[status ?? ""] ?? ["neutral", status ?? "Not a design"];
  return <ToneChip tone={tone} label={label} />;
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
