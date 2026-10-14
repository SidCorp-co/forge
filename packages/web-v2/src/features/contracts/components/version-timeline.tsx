import { useLayoutEffect, useRef, useState } from "react";
import { LEGEND, statusReading, Tooltip, useNow } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { formatStamp } from "@/lib/utils/format";
import type { ContractStandingRow, ContractVersionView } from "../types";

const DAY = 86_400_000;
// The width one mark's label takes: a version over its yyyy-mm-dd date, in 11.5px mono.
const LABEL_PX = 80;

const toneOf = (v: ContractVersionView) =>
  v.approval === "proposed" ? LEGEND.you.dot : v.approval === "returned" ? LEGEND.err.dot : v.classification === "breaking" ? LEGEND.err.dot : LEGEND.done.dot;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

type Mark = { head: ContractVersionView; rest: ContractVersionView[]; at: number };

/** Versions closer on the axis than one label is wide share one mark: the newest names it and the
 *  rest are counted on it, so labels never draw over each other however many land in one week. */
export function markVersions(versions: ContractVersionView[], px: (at: number) => number): Mark[] {
  const newestFirst = [...versions].sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  const marks: Mark[] = [];
  for (const v of newestFirst) {
    const at = new Date(v.recordedAt).getTime();
    const last = marks.at(-1);
    if (last && px(last.at) - px(at) < LABEL_PX) last.rest.push(v);
    else marks.push({ head: v, rest: [], at });
  }
  return marks;
}

export function VersionTimeline({ row, versions }: { row: ContractStandingRow; versions: ContractVersionView[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const now = useNow(60_000);
  const { ref, width } = useWidth();
  if (versions.length === 0) return <p className="text-13 text-subtle">{t("contracts.versions.none")}</p>;
  const due = row.window ? new Date(row.window.dueAt).getTime() : null;
  const times = [...versions.map((v) => new Date(v.recordedAt).getTime()), now, ...(due ? [due] : [])];
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const pad = Math.max(3 * DAY, (hi - lo) * 0.06);
  const start = lo - pad;
  const span = hi + pad - start;
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  // Before the axis is measured every version stands alone; the first layout pass merges them.
  const marks = markVersions(versions, (at) => (width ? ((at - start) / span) * width : at));
  const reading = (v: ContractVersionView) =>
    `${v.version} · ${statusReading("classification", v.classification, language).label} · ${statusReading("contractApproval", v.approval, language).label} · ${formatStamp(v.recordedAt)}`;
  return (
    <div data-testid="version-timeline" ref={ref}>
      <div className="relative h-18.5" role="img" aria-label={t("contracts.timeline.aria", { ref: row.ref, versions: versions.map((v) => v.version).join(", ") })}>
        <span aria-hidden className="absolute inset-x-0 top-3.5 h-px bg-line" />
        {row.window?.open && due ? (
          <span aria-hidden className="absolute top-3 h-1.25 rounded-pill" style={{ left: x(now), width: `calc(${x(due)} - ${x(now)})`, background: LEGEND.you.dot, opacity: 0.55 }} />
        ) : null}
        <span aria-hidden className="absolute top-1 h-5.5 border-l border-dashed border-neutral-8" style={{ left: x(now) }} title={t("contracts.timeline.today")} />
        {marks.map(({ head, rest, at }) => (
          <span key={head.version} className="absolute top-2 flex -translate-x-1/2 flex-col items-center" style={{ left: x(at) }} data-testid="timeline-mark">
            <Tooltip label={[head, ...rest].map(reading).join(" / ")} multiline>
              <span className="block size-3 rounded-full border-2 border-app" style={{ background: toneOf(head) }} />
            </Tooltip>
            <span className="mt-1 whitespace-nowrap font-mono text-11-5 font-semibold text-fg">
              {head.version}
              {rest.length ? <span className="font-normal text-subtle" data-testid="timeline-mark-more">{` +${rest.length}`}</span> : null}
            </span>
            <span className="whitespace-nowrap font-mono text-11 text-subtle">{head.recordedAt.slice(0, 10)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
