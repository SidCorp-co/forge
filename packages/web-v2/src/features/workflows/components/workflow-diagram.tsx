"use client";

import { useId } from "react";
import { cn } from "@/lib/utils/cn";
import { layoutOf } from "../layout";
import type { WorkflowDocument } from "../types";

export interface WorkflowDiagramProps {
  workflow: WorkflowDocument;
  selected: string;
  onSelect: (stepId: string) => void;
}

const COVERAGE_DOT: Record<string, string> = {
  walked: "var(--green-500)",
  not_walked: "var(--amber-500)",
};

export function WorkflowDiagram({ workflow, selected, onSelect }: WorkflowDiagramProps) {
  const marker = useId().replace(/:/g, "");
  const l = layoutOf(workflow.steps, workflow.kind);
  const drifted = new Set(workflow.drift?.steps ?? []);
  const state = workflow.kind === "state";
  return (
    <div
      className="flex min-h-[240px] items-center overflow-auto rounded-lg px-2 py-6"
      style={{ backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
      data-testid="workflow-diagram"
    >
      <div className="relative m-auto" style={{ width: l.width, height: l.height }}>
        <svg width={l.width} height={l.height} className="absolute left-0 top-0 overflow-visible" aria-hidden>
          <defs>
            <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--fg-subtle)" />
            </marker>
          </defs>
          {l.edges.map((e) => (
            <path
              key={`${e.from}-${e.to}`}
              d={e.d}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth={1.6}
              markerEnd={`url(#${marker})`}
            />
          ))}
        </svg>
        {l.steps.map(({ step, x, y }) => {
          const reading = step.evidence?.coverage.reading;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelect(step.id)}
              aria-pressed={selected === step.id}
              title={step.does}
              data-testid="workflow-node"
              data-step={step.id}
              className={cn(
                "absolute grid content-center gap-0.5 border-[1.5px] bg-surface px-3 py-2 text-left text-13",
                state ? "justify-items-center rounded-pill text-center" : "rounded-lg",
                step.status === "writing" ? "border-dashed text-muted" : "border-line-strong",
                drifted.has(step.id) && "border-amber",
                selected === step.id && "border-accent",
              )}
              style={{
                left: x,
                top: y,
                width: l.nodeW,
                height: l.nodeH,
                boxShadow:
                  selected === step.id
                    ? "0 0 0 3px var(--accent-tint)"
                    : drifted.has(step.id)
                      ? "0 0 0 3px var(--amber-50)"
                      : undefined,
              }}
            >
              <span className="font-mono text-12 font-semibold">{step.id}</span>
              {reading && COVERAGE_DOT[reading] ? (
                <i className="absolute right-2 top-2 size-2 rounded-full" style={{ background: COVERAGE_DOT[reading] }} />
              ) : null}
              {step.evidence ? (
                <span className="truncate text-11 text-subtle">{step.evidence.file.split("/").pop()}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
