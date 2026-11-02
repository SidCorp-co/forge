// A status and the reason behind it (REQ-11 BC-22): the face shows the state's word in its legend
// tone, and why it stands there (who it waits on, since when, what blocks it) opens on hover or on
// keyboard focus, never as a sentence beside it. A screen reader hears the reason with the state.

import type { ReactNode } from "react";
import { Tooltip as TooltipRoot, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, ToneBadge } from "../primitives/enum-badge";
import type { LegendTone, StatusFamily } from "../vocabulary";

type Badge =
  | { family: StatusFamily; value: string; label?: string; tone?: LegendTone; stage?: string | null }
  | { family?: undefined; tone: LegendTone; label: ReactNode; value?: string };

type StatusChipProps = Badge & {
  /** Why it stands here, in a few words: "You · answer a question". */
  reason?: string | null;
  testId?: string;
};

export function StatusChip({ reason, testId, ...badge }: StatusChipProps) {
  const drawn =
    badge.family !== undefined ? (
      <StatusBadge family={badge.family} value={badge.value} label={badge.label} tone={badge.tone} stage={badge.stage} />
    ) : (
      <ToneBadge tone={badge.tone} label={badge.label} value={badge.value} title={typeof badge.label === "string" ? badge.label : ""} />
    );
  if (!reason) return <span data-status-chip="" data-testid={testId} className="inline-flex max-w-full">{drawn}</span>;
  return (
    <TooltipRoot>
      <TooltipTrigger
        render={<span data-status-chip="" data-reason={reason} data-testid={testId} className="inline-flex max-w-full rounded-pill focus-visible:outline-none focus-visible:shadow-focus" />}
        tabIndex={0}
      >
        {drawn}
        <span className="sr-only">{reason}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="w-max max-w-[280px] whitespace-normal rounded-md bg-neutral-12 px-2 py-1 text-12 text-on-accent shadow-overlay">
        {reason}
      </TooltipContent>
    </TooltipRoot>
  );
}
