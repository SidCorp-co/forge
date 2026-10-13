
import { Link } from "@/lib/navigation/router";
import { HoverCard, LEGEND, statusReading, ToneBadge, Tooltip, WaitingOn } from "@/design";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import type { OverviewLane, OverviewMoving } from "../types";

const LABEL_FROM_SHARE = 0.09;

const TICK_STEPS_MIN = [15, 30, 60, 120, 180, 360, 720];

function ticksOf(from: number, to: number, most = 5): number[] {
  const span = to - from;
  const step = (TICK_STEPS_MIN.find((m) => span / (m * 60_000) <= most) ?? 1440) * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

function Track({ lane, from, to, now }: { lane: OverviewLane; from: number; to: number; now: number }) {
  const t = useCopy();
  const L = useLabel();
  const time = useTimeFormat();
  const pct = (ms: number) => `${(Math.min(Math.max((ms - from) / (to - from), 0), 1) * 100).toFixed(2)}%`;
  const segs = lane.segments.length
    ? lane.segments.map((s) => ({ label: L("workStep", s.step), a: new Date(s.startedAt).getTime(), b: s.endedAt ? new Date(s.endedAt).getTime() : now, open: s.endedAt === null }))
    : lane.heldSince
      ? [{ label: t("overview.lane.holding"), a: new Date(lane.heldSince).getTime(), b: now, open: true }]
      : [];
  const leaseEnd = lane.lease?.expiresAt ? new Date(lane.lease.expiresAt).getTime() : null;
  return (
    <div className="relative h-5 rounded-xs bg-sunken" role="img" aria-label={t("overview.lane.aria", { key: lane.key })}>
      {segs
        .filter((s) => s.b > from)
        .map((s) => (
          <div
            key={`${s.label}-${s.a}`}
            className="absolute top-0.5 h-4 [&>span]:flex [&>span]:h-full [&>span]:w-full"
            style={{ left: pct(s.a), width: `calc(${pct(s.b)} - ${pct(s.a)})` }}
          >
            <Tooltip label={t("overview.lane.span", { step: s.label, from: time.clock(s.a), to: s.open ? t("overview.lane.now") : time.clock(s.b) })}>
              <span
                className="items-center overflow-hidden whitespace-nowrap rounded-xs px-1.5 text-12 font-semibold text-on-accent"
                style={{ background: s.open ? LEGEND.run.dot : "var(--neutral-11)" }}
              >
                {(s.b - s.a) / (to - from) >= LABEL_FROM_SHARE ? s.label : null}
              </span>
            </Tooltip>
          </div>
        ))}
      {leaseEnd !== null && leaseEnd > now ? (
        <div
          className="absolute top-1.25 h-2.5 rounded-xs border border-dashed"
          style={{ left: pct(now), width: `calc(${pct(leaseEnd)} - ${pct(now)})`, borderColor: LEGEND.run.dot }}
          title={t("overview.lane.leaseUntil", { at: time.dateTime(lane.lease?.expiresAt as string) })}
        />
      ) : null}
      <div aria-hidden className="absolute -bottom-1 -top-1 w-0 border-l-2 border-fg" style={{ left: pct(now) }} />
    </div>
  );
}

function LaneDetail({ lane }: { lane: OverviewLane }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <dl className="flex flex-col gap-1.5 text-13">
      <LaneFact label={t("overview.lane.holder")}>
        <span className="break-all font-mono text-12">{lane.holder ?? t("overview.lane.noneRecorded")}</span>
      </LaneFact>
      {lane.box ? (
        <LaneFact label={t("overview.lane.box")}>
          <span className="font-mono text-12">{lane.box}</span>
        </LaneFact>
      ) : null}
      {lane.branch ? (
        <LaneFact label={t("overview.lane.branch")}>
          <span className="break-all font-mono text-12">{lane.branch}</span>
        </LaneFact>
      ) : null}
      {lane.lease ? (
        <LaneFact label={t("issues.facts.lease")}>
          <ToneBadge tone={statusReading("lease", lane.lease.verdict).tone} label={t(`issues.lease.${lane.lease.verdict}`)} title={lane.lease.verdict} value={lane.lease.verdict} />
          {lane.lease.expiresAt ? <span className="text-muted">{t("overview.lane.until", { at: time.dateTime(lane.lease.expiresAt) })}</span> : null}
        </LaneFact>
      ) : null}
      {lane.heldSince ? <LaneFact label={t("overview.lane.since")}>{time.dateTime(lane.heldSince)}</LaneFact> : null}
    </dl>
  );
}

function LaneFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-21 flex-none text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

export function LeaseLanes({ moving, slug }: { moving: OverviewMoving; slug: string }) {
  const w = moving.window;
  const t = useCopy();
  const time = useTimeFormat();
  if (!w) return <p className="text-13 text-muted">{t("overview.lane.empty")}</p>;
  const from = new Date(w.from).getTime();
  const to = new Date(w.to).getTime();
  const now = new Date(w.now).getTime();
  return (
    <div data-testid="lease-lanes">
      <div className="flex flex-col gap-3.5">
        {moving.lanes.map((lane) => (
          <div key={lane.key} className="flex items-center gap-3" data-testid="lane" data-key={lane.key}>
            <div className="flex w-42 min-w-0 flex-none flex-col gap-0.5">
              <Link href={issueHref(slug, lane.key)} className="truncate font-mono text-12 font-semibold text-link no-underline hover:underline" title={lane.title}>
                {lane.key}
              </Link>
              <HoverCard label={t("overview.lane.runOn", { key: lane.key })} content={<LaneDetail lane={lane} />} placement="bottom-start">
                <WaitingOn w={lane.waitingOn} />
              </HoverCard>
            </div>
            <div className="min-w-0 flex-1">
              <Track lane={lane} from={from} to={to} now={now} />
            </div>
          </div>
        ))}
        <div className="relative ml-45 h-4 text-12 text-muted" aria-hidden>
          {ticksOf(from, to).map((tick) => (
            <span key={tick} className="absolute -translate-x-1/2 font-mono tabular-nums" style={{ left: `${(((tick - from) / (to - from)) * 100).toFixed(2)}%` }}>
              {time.clock(tick)}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-2.5 text-12 text-muted">{t("overview.lane.legend")}</p>
    </div>
  );
}
