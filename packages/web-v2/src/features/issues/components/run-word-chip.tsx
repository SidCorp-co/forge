import { StatusChip } from "@/design";
import type { RunWord } from "@/features/runs/derive";

/** The run's word on the issue page. A kept word's time sits beside the chip, whose label is cut at 28ch (ISS-1228 r27). */
export function RunWordChip({
  word,
  asOf,
  stage,
  size,
}: {
  word: RunWord;
  asOf: string | null;
  stage?: string | undefined;
  size?: "sm" | "md";
}) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      <span className="inline-flex" title={word.detail}>
        <StatusChip status={word.status} label={word.label} stage={stage} size={size} domain="session" />
      </span>
      {asOf && <span className="fg-caption fg-caption-stale whitespace-nowrap">as of {asOf}</span>}
    </span>
  );
}
