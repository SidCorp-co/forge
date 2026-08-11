"use client";

import { HealthDot, Kicker, Tooltip } from "@/design";
import { OPERATOR_SECTIONS } from "../nav-model";
import type { OperatorSectionKey } from "../types";

const STATUS_PILLS = ["db", "queue", "ws"] as const;

/** Operator-owned header — `@/design` TopBar bakes an unconditional "New
 *  issue" CTA with no slot for these health pills, so this console gets its
 *  own header built from primitives instead (ISS-650 plan decision 5). */
export function OperatorTopbar({ section }: { section: OperatorSectionKey }) {
  const label = OPERATOR_SECTIONS.find((s) => s.key === section)?.label ?? "Overview";
  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-5">
      <Kicker>Operator</Kicker>
      <span className="fg-h3" style={{ fontSize: 15 }}>
        {label}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {STATUS_PILLS.map((key) => (
          <Tooltip key={key} label={`${key.toUpperCase()} health checks aren't wired up yet`}>
            <span className="inline-flex items-center gap-1.5 rounded-pill border border-line px-2 py-1">
              <span className="fg-overline">{key}</span>
              <HealthDot health="idle" withLabel={false} />
            </span>
          </Tooltip>
        ))}
      </div>
    </header>
  );
}
