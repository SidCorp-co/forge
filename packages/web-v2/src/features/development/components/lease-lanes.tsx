"use client";

import { WORK_STEP_LABELS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { HoverCard, LEGEND, StatusBadge, Tooltip, WaitingOn } from "@/design";
import { issueHref } from "@/features/issues/routes";
import { formatStamp } from "@/lib/utils/format";
import type { OverviewLane, OverviewMoving } from "../types";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const LABEL_FROM_SHARE = 0.09;

const TICK_STEPS_MIN = [15, 30, 60, 120, 180, 360, 720];

export function ticksOf(from: number, to: number, most = 5): number[] {
  const span = to - from;
  const step = (TICK_STEPS_MIN.find((m) => span / (m * 60_000) <= most) ?? 1440) * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

function Track({ lane, from, to, now }: { lane: OverviewLane; from: number; to: number; now: number }) {
  const pct = (ms: number) => `${(Math.min(Math.max((ms - from) / (to - from), 0), 1) * 100).toFixed(2)}%`;
  const segs = lane.segments.length
    ? lane.segments.map((s) => ({ label: WORK_STEP_LABELS[s.step], a: new Date(s.startedAt).getTime(), b: s.endedAt ? new Date(s.endedAt).getTime() : now, open: s.endedAt === null }))
    : lane.heldSince
      ? [{ label: "Holding", a: new Date(lane.heldSince).getTime(), b: now, open: true }]
      : [];
  const leaseEnd = lane.lease?.expiresAt ? new Date(lane.lease.expiresAt).getTime() : null;
  return (
    <div className="relative h-5 rounded-[3px] bg-sunken" role="img" aria-label={`${lane.key} run lane`}>
      {segs
        .filter((s) => s.b > from)
        .map((s) => (
          <div
            key={`${s.label}-${s.a}`}
            className="absolute top-0.5 h-4 [&>span]:flex [&>span]:h-full [&>span]:w-full"
            style={{ left: pct(s.a), width: `calc(${pct(s.b)} - ${pct(s.a)})` }}
          >
            <Tooltip label={`${s.label} · ${clock(s.a)} to ${s.open ? "now" : clock(s.b)}`}>
              <span
                className="items-center overflow-hidden whitespace-nowrap rounded-[3px] px-1.5 text-10 font-semibold text-on-accent"
                style={{ background: s.open ? LEGEND.run.dot : "var(--ink-600)" }}
              >
                {(s.b - s.a) / (to - from) >= LABEL_FROM_SHARE ? s.label : null}
              </span>
            </Tooltip>
          </div>
        ))}
      {leaseEnd !== null && leaseEnd > now ? (
        <div
          className="absolute top-[5px] h-2.5 rounded-[3px] border border-dashed"
          style={{ left: pct(now), width: `calc(${pct(leaseEnd)} - ${pct(now)})`, borderColor: LEGEND.run.dot }}
          title={`Lease held until ${formatStamp(lane.lease?.expiresAt as string)}`}
        />
      ) : null}
      <div aria-hidden className="absolute -bottom-1 -top-1 w-0 border-l-[1.5px] border-fg" style={{ left: pct(now) }} />
    </div>
  );
}

function LaneDetail({ lane }: { lane: OverviewLane }) {
  return (
    <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-12-5">
      <dt className="text-muted">Holder</dt>
      <dd className="min-w-0 break-all font-mono text-12">{lane.holder ?? "None recorded"}</dd>
      {lane.box ? (
        <>
          <dt className="text-muted">Box</dt>
          <dd className="font-mono text-12">{lane.box}</dd>
        </>
      ) : null}
      {lane.branch ? (
        <>
          <dt className="text-muted">Branch</dt>
          <dd className="break-all font-mono text-12">{lane.branch}</dd>
        </>
      ) : null}
      {lane.lease ? (
        <>
          <dt className="text-muted">Lease</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            <StatusBadge family="lease" value={lane.lease.verdict} />
            {lane.lease.expiresAt ? <span className="text-muted">until {formatStamp(lane.lease.expiresAt)}</span> : null}
          </dd>
        </>
      ) : null}
      {lane.heldSince ? (
        <>
          <dt className="text-muted">Since</dt>
          <dd>{formatStamp(lane.heldSince)}</dd>
        </>
      ) : null}
    </dl>
  );
}

export function LeaseLanes({ moving, slug }: { moving: OverviewMoving; slug: string }) {
  const w = moving.window;
  if (!w) return <p className="text-13 text-muted">Nothing is running. A run that holds a lease appears here with the steps it has been in.</p>;
  const from = new Date(w.from).getTime();
  const to = new Date(w.to).getTime();
  const now = new Date(w.now).getTime();
  return (
    <div data-testid="lease-lanes">
      <div className="grid grid-cols-[minmax(120px,168px)_minmax(0,1fr)] items-center gap-x-3 gap-y-3.5">
        {moving.lanes.map((lane) => (
          <div key={lane.key} className="contents" data-testid="lane" data-key={lane.key}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link href={issueHref(slug, lane.key)} className="truncate font-mono text-11-5 font-semibold text-link no-underline hover:underline" title={lane.title}>
                {lane.key}
              </Link>
              <HoverCard label={`Run on ${lane.key}`} content={<LaneDetail lane={lane} />} placement="bottom-start">
                <WaitingOn w={lane.waitingOn} />
              </HoverCard>
            </div>
            <Track lane={lane} from={from} to={to} now={now} />
          </div>
        ))}
        <div />
        <div className="relative h-4 text-11 text-muted" aria-hidden>
          {ticksOf(from, to).map((t) => (
            <span key={t} className="absolute -translate-x-1/2 font-mono tabular-nums" style={{ left: `${(((t - from) / (to - from)) * 100).toFixed(2)}%` }}>
              {clock(t)}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-2.5 text-12 text-muted">Solid: steps the run has been in. Dashed: the lease still held. Line: now.</p>
    </div>
  );
}
