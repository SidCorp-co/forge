"use client";

import { useState } from "react";
import { CoverageBar, Icon } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { partSegments, partsLine } from "../derive";
import type { OverviewModuleRow, OverviewModules } from "../types";

function Row({ m, max }: { m: OverviewModuleRow; max: number }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <div className="contents" data-testid="module-row" data-module={m.path || "none"}>
      <span className={m.path ? "truncate font-mono text-12 font-semibold text-fg" : "truncate text-12-5 text-muted"} title={m.name}>
        {m.path || m.name}
      </span>
      <span className="block" title={m.open ? partsLine(m.parts, t) : t("overview.dev.nothingOpen")}>
        {m.open ? (
          <span className="block" style={{ width: `${Math.max((m.open / max) * 100, 6)}%` }}>
            <CoverageBar segments={partSegments(m.parts, t)} legend={false} />
          </span>
        ) : (
          <span aria-hidden className="block h-2 w-full rounded-pill bg-[var(--paper-200)]" />
        )}
      </span>
      <span className="whitespace-nowrap text-right font-mono text-12 tabular-nums text-muted" title={m.lastLandingAt ? t("overview.dev.lastLanding", { at: time.dateTime(m.lastLandingAt) }) : t("overview.dev.nothingLanded")}>
        {t("overview.dev.moduleCounts", { open: m.open, shipped: m.shipped })}
        {m.lastLandingAt ? ` · ${time.age(m.lastLandingAt)}` : ""}
      </span>
    </div>
  );
}

const GRID = "grid grid-cols-[minmax(90px,170px)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5";

export function ModuleBars({ modules }: { modules: OverviewModules }) {
  const [quietOpen, setQuietOpen] = useState(false);
  const t = useCopy();
  const live = modules.rows.filter((m) => m.open > 0);
  const quiet = modules.rows.filter((m) => m.open === 0);
  const loose = modules.unassigned;
  const none = modules.rows.length === 0;
  if (none && loose.open === 0 && loose.shipped === 0) return <p className="text-13 text-muted">{t("overview.dev.noModules")}</p>;
  return (
    <div data-testid="module-bars">
      <div className={GRID}>
        {live.map((m) => (
          <Row key={m.id} m={m} max={modules.max} />
        ))}
        {loose.open > 0 || loose.shipped > 0 ? <Row m={{ ...loose, name: t("issues.board.noModule") }} max={modules.max} /> : null}
      </div>
      {none ? <p className="mt-2.5 text-12 text-muted">{t("overview.dev.noModulesAll")}</p> : null}
      {quiet.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            aria-expanded={quietOpen}
            onClick={() => setQuietOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 text-12-5 font-semibold text-muted hover:text-fg"
          >
            <Icon name="chevronRight" size={12} className={quietOpen ? "rotate-90" : undefined} />
            {t("overview.dev.quiet", { n: quiet.length })}
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
      {modules.max > 0 ? <p className="mt-2.5 text-12 text-muted">{t("overview.dev.oneScale")}</p> : null}
    </div>
  );
}
