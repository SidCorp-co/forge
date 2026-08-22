// The seven-stage pipeline strip, read off the run this session belongs to.
// Answers "where in the pipeline am I" before the reader has scrolled — the
// session alone cannot say that, it only knows its own step.

import { formatDurationMs } from "@/features/pipeline/derive";
import type { PipelineRunStepSummary, PipelineRunSummary } from "@/features/pipeline/types";
import { STAGES } from "@/design";

const TICK: Record<string, { glyph: string; color: string }> = {
  done: { glyph: "✓", color: "var(--green-600)" },
  failed: { glyph: "✕", color: "var(--red-600)" },
  running: { glyph: "●", color: "var(--pipeline-active)" },
};

function stepOf(run: PipelineRunSummary, jobType: string): PipelineRunStepSummary | undefined {
  return run.steps.find((s) => s.jobType === jobType);
}

export function StepStrip({ run, currentStep }: { run: PipelineRunSummary; currentStep?: string }) {
  return (
    <ol className="flex list-none gap-1.5 overflow-x-auto" aria-label="Pipeline run">
      {STAGES.map((stage) => {
        const step = stepOf(run, stage.key);
        const tick = step ? (TICK[step.status] ?? { glyph: "·", color: "var(--fg-disabled)" }) : null;
        const isCurrent = stage.key === currentStep;
        return (
          <li
            key={stage.key}
            aria-current={isCurrent ? "step" : undefined}
            className="min-w-[104px] flex-1 rounded-md border px-2.5 py-2"
            style={{
              borderColor: isCurrent ? "var(--border-strong)" : "var(--border-subtle)",
              background: step ? "var(--bg-surface)" : "transparent",
            }}
          >
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" style={{ color: tick?.color ?? "var(--fg-disabled)" }}>
                {tick?.glyph ?? "·"}
              </span>
              <span className="fg-body-sm truncate">{stage.key}</span>
              <span className="fg-caption ml-auto">
                {step?.durationMs != null ? formatDurationMs(step.durationMs) : "—"}
              </span>
            </div>
            <div
              className="mt-1.5 h-0.5 rounded-pill"
              style={{ background: step ? stage.color : "var(--border-subtle)" }}
            />
          </li>
        );
      })}
    </ol>
  );
}
