// The pipeline strip, read off the RUN this session belongs to — its own steps,
// each under the name the run gave it, in one neutral accent.

import { formatDurationMs } from "@/lib/utils/format";
import type { PipelineRunSummary } from "@/features/runs/types";

const TICK: Record<string, { glyph: string; color: string }> = {
  completed: { glyph: "✓", color: "var(--green-600)" },
  done: { glyph: "✓", color: "var(--green-600)" },
  failed: { glyph: "✕", color: "var(--red-600)" },
  cancelled: { glyph: "⊘", color: "var(--fg-subtle)" },
  running: { glyph: "●", color: "var(--pipeline-active)" },
};

export function StepStrip({ run, currentStep }: { run: PipelineRunSummary; currentStep?: string }) {
  if (run.steps.length === 0) return null;
  return (
    <ol className="flex list-none gap-1.5 overflow-x-auto" aria-label="Pipeline run">
      {run.steps.map((step) => {
        const tick = TICK[step.status] ?? { glyph: "·", color: "var(--fg-disabled)" };
        const isCurrent = step.jobType === currentStep;
        return (
          <li
            key={`${step.jobType}-${step.startedAt ?? ""}`}
            aria-current={isCurrent ? "step" : undefined}
            className="min-w-[112px] flex-1 rounded-md border bg-surface px-2.5 py-2"
            style={{ borderColor: isCurrent ? "var(--border-strong)" : "var(--border-subtle)" }}
          >
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" style={{ color: tick.color }}>
                {tick.glyph}
              </span>
              <span className="fg-body-sm truncate">{step.jobType}</span>
              <span className="fg-caption ml-auto">
                {step.durationMs != null ? formatDurationMs(step.durationMs) : "—"}
              </span>
            </div>
            <div
              className="mt-1.5 h-0.5 rounded-pill"
              style={{ background: "var(--border-strong)" }}
            />
          </li>
        );
      })}
    </ol>
  );
}
