"use client";

import { LEGEND, statusReading, Tooltip } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { formatStamp } from "@/lib/utils/format";
import type { ContractStandingRow, ContractVersionView } from "../types";

const DAY = 86_400_000;

const toneOf = (v: ContractVersionView) =>
  v.approval === "proposed" ? LEGEND.you.dot : v.approval === "returned" ? LEGEND.err.dot : v.classification === "breaking" ? LEGEND.err.dot : LEGEND.done.dot;

export function VersionTimeline({ row, versions }: { row: ContractStandingRow; versions: ContractVersionView[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (versions.length === 0) return <p className="text-13 text-subtle">{t("contracts.versions.none")}</p>;
  const now = Date.now();
  const due = row.window ? new Date(row.window.dueAt).getTime() : null;
  const times = [...versions.map((v) => new Date(v.recordedAt).getTime()), now, ...(due ? [due] : [])];
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const pad = Math.max(3 * DAY, (hi - lo) * 0.06);
  const start = lo - pad;
  const span = hi + pad - start;
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  const ours = row.direction === "consumed" ? row.ours : row.current?.version;
  return (
    <div data-testid="version-timeline">
      <div className="relative h-[74px]" role="img" aria-label={t("contracts.timeline.aria", { ref: row.ref, versions: versions.map((v) => v.version).join(", ") })}>
        <span aria-hidden className="absolute inset-x-0 top-[14px] h-px bg-[var(--border-default)]" />
        {row.window?.open && due ? (
          <span aria-hidden className="absolute top-[12px] h-[5px] rounded-pill" style={{ left: x(now), width: `calc(${x(due)} - ${x(now)})`, background: LEGEND.you.dot, opacity: 0.55 }} />
        ) : null}
        <span aria-hidden className="absolute top-[4px] h-[22px] border-l border-dashed border-[var(--ink-400)]" style={{ left: x(now) }} title={t("contracts.timeline.today")} />
        {versions.map((v) => {
          const at = new Date(v.recordedAt).getTime();
          const label = `${v.version}${v.version === ours ? ` · ${row.direction === "consumed" ? t("contracts.timeline.weUse") : t("contracts.timeline.current")}` : ""}`;
          return (
            <span key={v.version} className="absolute top-[8px] flex -translate-x-1/2 flex-col items-center" style={{ left: x(at) }} data-testid="timeline-mark">
              <Tooltip label={`${v.version} · ${statusReading("classification", v.classification, language).label} · ${statusReading("contractApproval", v.approval, language).label} · ${formatStamp(v.recordedAt)}`} multiline>
                <span className="block size-3 rounded-full border-2 border-[var(--bg-app)]" style={{ background: toneOf(v) }} />
              </Tooltip>
              <span className="mt-1 whitespace-nowrap font-mono text-11-5 font-semibold text-fg">{label}</span>
              <span className="whitespace-nowrap font-mono text-11 text-subtle">{v.recordedAt.slice(0, 10)}</span>
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-12 text-subtle">
        {t("contracts.timeline.legend")}
        {row.window?.open ? ` ${t("contracts.timeline.band", { v: row.window.version, to: row.window.dueAt.slice(0, 10) })}` : ""}
      </p>
    </div>
  );
}
