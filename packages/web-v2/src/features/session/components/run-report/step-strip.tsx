// The pipeline strip, read off the RUN this session belongs to — its own steps,
// not the seven canonical stages.
//
// getcontent's `drive` step is the reason: hard-coding STAGES rendered seven
// empty boxes for a run whose only step was named something else, on the exact
// page whose job is to say where in the pipeline this is. STAGES now only
// supplies the accent colour when a step happens to be one of them.

import { STAGES } from "@/design";
import { formatDurationMs } from "@/features/pipeline/derive";
import type { PipelineRunSummary } from "@/features/pipeline/types";

const TICK: Record<string, { glyph: string; color: string }> = {
  completed: { glyph: "✓", color: "var(--green-600)" },
  done: { glyph: "✓", color: "var(--green-600)" },
  failed: { glyph: "✕", color: "var(--red-600)" },
  cancelled: { glyph: "⊘", color: "var(--fg-subtle)" },
  running: { glyph: "●", color: "var(--pipeline-active)" },
};

function accentOf(jobType: string): string {
  return STAGES.find((s) => s.key === jobType)?.color ?? "var(--border-strong)";
}

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
              style={{ background: accentOf(step.jobType) }}
            />
          </li>
        );
      })}
    </ol>
  );
}
