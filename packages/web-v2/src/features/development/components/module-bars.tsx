"use client";

import { useState } from "react";
import { CoverageBar, Icon } from "@/design";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { partSegments, partsLine } from "../derive";
import type { OverviewModuleRow, OverviewModules } from "../types";

function Row({ m, max }: { m: OverviewModuleRow; max: number }) {
  return (
    <div className="contents" data-testid="module-row" data-module={m.path || "none"}>
      <span className={m.path ? "truncate font-mono text-12 font-semibold text-fg" : "truncate text-12-5 text-muted"} title={m.name}>
        {m.path || m.name}
      </span>
      <span className="block" title={m.open ? partsLine(m.parts) : "Nothing open"}>
        {m.open ? (
          <span className="block" style={{ width: `${Math.max((m.open / max) * 100, 6)}%` }}>
            <CoverageBar segments={partSegments(m.parts)} legend={false} />
          </span>
        ) : (
          <span aria-hidden className="block h-2 w-full rounded-pill bg-[var(--paper-200)]" />
        )}
      </span>
      <span className="whitespace-nowrap text-right font-mono text-12 tabular-nums text-muted" title={m.lastLandingAt ? `Last landing ${formatStamp(m.lastLandingAt)}` : "Nothing has landed"}>
        Open {m.open} · Shipped {m.shipped}
        {m.lastLandingAt ? ` · ${formatAge(m.lastLandingAt)}` : ""}
      </span>
    </div>
  );
}

const GRID = "grid grid-cols-[minmax(90px,170px)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5";

export function ModuleBars({ modules }: { modules: OverviewModules }) {
  const [quietOpen, setQuietOpen] = useState(false);
  const live = modules.rows.filter((m) => m.open > 0);
  const quiet = modules.rows.filter((m) => m.open === 0);
  const loose = modules.unassigned;
  const none = modules.rows.length === 0;
  if (none && loose.open === 0 && loose.shipped === 0) return <p className="text-13 text-muted">No module is defined on this project yet.</p>;
  return (
    <div data-testid="module-bars">
      <div className={GRID}>
        {live.map((m) => (
          <Row key={m.id} m={m} max={modules.max} />
        ))}
        {loose.open > 0 || loose.shipped > 0 ? <Row m={loose} max={modules.max} /> : null}
      </div>
      {none ? <p className="mt-2.5 text-12 text-muted">No module is defined on this project yet, so every issue sits under no module.</p> : null}
      {quiet.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={quietOpen}
            onClick={() => setQuietOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 text-12-5 font-semibold text-muted hover:text-fg"
          >
            <Icon name="chevronRight" size={12} className={quietOpen ? "rotate-90" : undefined} />
            Quiet {quiet.length}
          </button>
          {quietOpen ? (
            <div className={`${GRID} mt-2.5`}>
              {quiet.map((m) => (
                <Row key={m.id} m={m} max={modules.max} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {modules.max > 0 ? <p className="mt-2.5 text-12 text-muted">One scale for every bar; an issue is counted once, under its primary module.</p> : null}
    </div>
  );
}
