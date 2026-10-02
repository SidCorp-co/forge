"use client";

import { useId } from "react";
import { cn } from "@/lib/utils/cn";
import { contractText, type DesignDiff, edgeKey } from "../design-diff";
import { layoutOf } from "../layout";
import type { WorkflowBody, WorkflowStep } from "../types";

export interface WorkflowDiagramProps {
  workflow: Pick<WorkflowBody, "kind" | "drift" | "edges"> & { steps: WorkflowStep[] };
  selected: string;
  onSelect: (stepId: string) => void;
  /** With "changes since approved" on: what the proposed revision adds, changes and removes. */
  diff?: DesignDiff | null;
}

const COVERAGE_DOT: Record<string, string> = {
  walked: "var(--green-500)",
  not_walked: "var(--amber-500)",
};

const MARK_BORDER = { added: "border-green", changed: "border-amber", removed: "border-red" } as const;
const MARK_STROKE = { added: "var(--green-500)", changed: "var(--amber-500)", removed: "var(--red-500)" } as const;

function evidenceLabel(step: WorkflowStep): string | null {
  const e = step.evidence;
  if (!e) return null;
  return e.kind === "storefront" ? `${e.ref} ${e.id}` : (e.file.split("/").pop() ?? e.file);
}

export function WorkflowDiagram({ workflow, selected, onSelect, diff = null }: WorkflowDiagramProps) {
  const marker = useId().replace(/:/g, "");
  const l = layoutOf(workflow.steps, workflow.kind);
  const drifted = new Set(workflow.drift?.steps ?? []);
  const state = workflow.kind === "state";
  const contracts = new Map((workflow.edges ?? []).map((e) => [edgeKey(e.from, e.to), e]));
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
          {l.edges.map((e) => {
            const key = edgeKey(e.from, e.to);
            const contract = contracts.get(key);
            const mark = diff?.edges.get(key) ?? diff?.steps.get(e.to);
            return (
              <g key={key} data-testid="workflow-edge" data-edge={key}>
                <path
                  d={e.d}
                  fill="none"
                  stroke={mark && mark !== "changed" ? MARK_STROKE[mark] : contract ? "var(--accent)" : "var(--border-strong)"}
                  strokeWidth={contract ? 2 : 1.6}
                  strokeDasharray={diff?.steps.get(e.to) === "removed" ? "4 3" : undefined}
                  markerEnd={`url(#${marker})`}
                />
                {contract ? (
                  <path d={e.d} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke">
                    <title>{contractText(contract)}</title>
                  </path>
                ) : null}
              </g>
            );
          })}
        </svg>
        {l.steps.map(({ step, x, y }) => {
          const reading = step.evidence?.coverage?.reading;
          const mark = diff?.steps.get(step.id);
          const evidence = evidenceLabel(step);
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onSelect(step.id)}
              aria-pressed={selected === step.id}
              title={[step.node?.type, step.does, mark].filter(Boolean).join(" · ")}
              data-testid="workflow-node"
              data-step={step.id}
              data-mark={mark}
              className={cn(
                "absolute grid content-center gap-0.5 border-[1.5px] bg-surface px-3 py-2 text-left text-13",
                state ? "justify-items-center rounded-pill text-center" : "rounded-lg",
                step.status === "writing" || step.status === "designed" ? "border-dashed" : "border-line-strong",
                step.status === "writing" && "text-muted",
                step.status === "designed" && "border-line-strong",
                drifted.has(step.id) && "border-amber",
                mark && MARK_BORDER[mark],
                mark === "removed" && "opacity-60 line-through",
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
              {step.node ? (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle" data-testid="workflow-node-type">
                  {step.node.type}
                </span>
              ) : null}
              <span className="truncate font-mono text-12 font-semibold">{step.id}</span>
              {reading && COVERAGE_DOT[reading] ? (
                <i className="absolute right-2 top-2 size-2 rounded-full" style={{ background: COVERAGE_DOT[reading] }} />
              ) : null}
              {evidence && !step.node ? <span className="truncate text-11 text-subtle">{evidence}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
