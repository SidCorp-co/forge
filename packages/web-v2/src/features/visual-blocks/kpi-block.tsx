"use client";

import { keyedByContent } from "@/design";
import { kpiFigures, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import { useBlockInstants } from "./instants";

/** A kpi block: a flat row of figures, each a label over its value, a delta beside it where the block names one. */
export function KpiBlockView({ block }: { block: VisualBlockOf<"kpi"> }) {
  const instants = useBlockInstants();
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      {keyedByContent(kpiFigures(block, instants), (fig) => fig.label).map(({ key, item: fig }) => (
        // two figures may share a label: the nth figure under it is its identity
        <div key={key} className="min-w-0" data-testid="kpi-figure">
          <dt className="text-12 text-subtle">{fig.label}</dt>
          <dd className="m-0 flex items-baseline gap-1.5">
            <span className="text-24 font-semibold leading-tight tabular-nums text-fg">{fig.value}</span>
            {fig.delta !== undefined && <span className="text-12 tabular-nums text-muted">{fig.delta}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
