
// The small marks the onboarding thread and the questionnaire share: a hover note with rich
// content (the evidence behind "Why we ask") and the design status.

import type { IssueStatusTone } from "@forge/contracts/issue-vocabulary";
import type { ReactNode } from "react";
import { HoverCard, StatusBadge, ToneBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

/** A dotted-underline word whose hover card carries a sentence and its evidence. */
export function HoverNote({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <HoverCard
      label={label}
      content={<span className="block max-w-70 text-12 leading-normal">{children}</span>}
      placement="top"
      className={cn("whitespace-nowrap underline decoration-dotted decoration-line-strong underline-offset-3", className)}
    >
      {label}
    </HoverCard>
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

/** A legend-toned mark with its own words ("New", "Open", "Plan from code"): the shared ToneBadge. */
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

export function DesignStatus({ status }: { status: string | null }) {
  const t = useCopy();
  return status ? <StatusBadge family="design" value={status} /> : <ToneChip tone="neutral" label={t("onboarding.notDesign")} />;
}

/** The agent's own marks: Inferred beside a default it read from the code, New on a question it just raised. */
export function AiMark({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-0.75 whitespace-nowrap text-12 font-semibold text-ai before:size-1.25 before:rounded-full before:bg-ai-9"
    >
      {children}
    </span>
  );
}
