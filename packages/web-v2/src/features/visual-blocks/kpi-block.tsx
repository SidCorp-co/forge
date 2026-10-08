"use client";

import { kpiFigures, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import { useBlockInstants } from "./instants";

/** A kpi block: a flat row of figures, each a label over its value, a delta beside it where the block names one. */
export function KpiBlockView({ block }: { block: VisualBlockOf<"kpi"> }) {
  const instants = useBlockInstants();
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      {kpiFigures(block, instants).map((fig, i) => (
        // two figures may share a label; position is their identity
        // biome-ignore lint/suspicious/noArrayIndexKey: figures are positional
        <div key={i} className="min-w-0" data-testid="kpi-figure">
          <dt className="text-[11.5px] text-subtle">{fig.label}</dt>
          <dd className="m-0 flex items-baseline gap-1.5">
            <span className="text-[22px] font-semibold leading-tight tabular-nums text-fg">{fig.value}</span>
            {fig.delta !== undefined && <span className="text-[12px] tabular-nums text-muted">{fig.delta}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
