"use client";

// Workspace-tier Usage screen (`/usage`, ISS-359) — replaces the old Activity
// destination. Token-spend overview across the workspace, built to the redesign
// draft (`design/draft-screen/09 Usage.html`) and the first adopter of the new
// wide-layout standard (<PageContainer width="wide">).
//
// DATA: web-v2 has no cross-project cost/spend aggregation endpoint yet — v1's
// usage dashboard is per-project only (`GET /api/usage-records/summary` requires
// a projectId). Rather than fan out N per-project calls and invent a rollup, the
// first cut renders the full draft layout with clearly-labelled SAMPLE figures
// (see the preview banner). Wiring real spend is a follow-up once a workspace
// metering endpoint exists — do NOT fabricate API routes here.
import { useState } from "react";
import {
  Banner,
  Card,
  PageContainer,
  SegmentedControl,
  stageColor,
  type SegmentOption,
} from "@/design";
import { cn } from "@/lib/utils/cn";

type Period = "7d" | "30d" | "90d";

const PERIOD_OPTIONS: SegmentOption<Period>[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
];

// --- Sample data (see DATA note above) --------------------------------------
const STATS = [
  { k: "Today", v: "$13.76", sub: "+$1.27 in flight" },
  { k: "This week", v: "$94.20", sub: "↑ 12% vs last" },
  { k: "This month", v: "$387.10", sub: "19 days in" },
  { k: "Projected", v: "$612", sub: "of $700 budget", amber: true },
  { k: "Tokens · 30d", v: "418M", sub: "in + out" },
];

// Daily spend sparkline heights (% of panel), mirrors the draft's 30-bar shape.
const SPEND_BARS = [
  30, 42, 38, 56, 48, 30, 22, 64, 58, 72, 50, 44, 68, 80, 62, 54, 40, 70, 88, 66,
  58, 46, 76, 92, 70, 60, 52, 78, 84, 96,
];

const BY_PROJECT = [
  { name: "forge-core", pct: 100, value: "$168.40", color: "var(--flame-500)" },
  { name: "data-pipeline", pct: 54, value: "$91.20", color: "var(--amber-500)" },
  { name: "forge-runner", pct: 34, value: "$58.10", color: "var(--red-500)" },
  { name: "forge-web", pct: 22, value: "$37.80", color: "var(--cobalt-500)" },
  { name: "forge-mcp", pct: 13, value: "$21.40", color: "var(--green-500)" },
  { name: "4 more", pct: 6, value: "$10.20", color: "var(--fg-subtle)" },
];

const BY_MODEL = [
  { name: "opus", pct: 100, value: "$214", color: "var(--flame-500)" },
  { name: "sonnet", pct: 68, value: "$148", color: "var(--cobalt-500)" },
  { name: "haiku", pct: 11, value: "$25", color: "var(--green-500)" },
];

const BY_STAGE = [
  { name: "code", pct: 100, value: "$221", color: stageColor("code") },
  { name: "review", pct: 42, value: "$92", color: stageColor("review") },
  { name: "test", pct: 27, value: "$58", color: stageColor("test") },
  { name: "other", pct: 7, value: "$16", color: "var(--fg-subtle)" },
];

function PanelHead({ title, ct, more }: { title: string; ct?: string; more?: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line-subtle px-[18px] py-3.5">
      <h2 className="fg-h3">{title}</h2>
      {ct && <span className="fg-caption text-subtle">{ct}</span>}
      {more && <span className="ml-auto font-mono text-sm font-semibold text-fg">{more}</span>}
    </div>
  );
}

/** A horizontal breakdown row: name · proportional track · value. */
function BreakRow({
  name,
  pct,
  value,
  color,
  nameWidth,
}: {
  name: string;
  pct: number;
  value: string;
  color: string;
  nameWidth?: number;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line-subtle py-[11px] last:border-0">
      <span
        className="flex flex-none items-center gap-2 text-[13px] text-fg"
        style={{ minWidth: nameWidth }}
      >
        <span className="size-2 flex-none rounded-pill" style={{ background: color }} />
        {name}
      </span>
      <span className="h-1 flex-1 overflow-hidden rounded-pill bg-sunken">
        <span
          className="block h-full rounded-pill"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
        />
      </span>
      <span className="flex-none font-mono text-[13px] font-semibold text-fg">{value}</span>
    </div>
  );
}

export function UsageScreen() {
  const [period, setPeriod] = useState<Period>("30d");

  return (
    <PageContainer width="wide">
      {/* Screen header */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="fg-h2">Usage</h1>
          <p className="fg-body-sm mt-0.5 text-muted">
            Token spend across the workspace · self-hosted · all projects
          </p>
        </div>
        <SegmentedControl options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
      </header>

      <Banner tone="info">
        Preview — figures shown are sample data. Workspace-wide spend metering is
        not wired yet; this screen lands the layout ahead of a usage endpoint.
      </Banner>

      {/* KPI / stat row */}
      <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
        {STATS.map((s) => (
          <div key={s.k} className="bg-surface px-4 py-3.5">
            <p className="fg-overline">{s.k}</p>
            <p
              className={cn(
                "mt-1 font-mono text-xl font-semibold",
                s.amber ? "text-[color:var(--amber-600)]" : "text-fg",
              )}
            >
              {s.v}
            </p>
            <p className="fg-body-sm mt-0.5 text-subtle">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Two-column grid: spend + by-project | by-model + by-stage + budget */}
      <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Spend over time */}
          <Card>
            <PanelHead title="Spend" ct={`last ${period}`} more="$387.10" />
            <div className="flex h-[200px] items-end gap-[5px] p-[18px]">
              {SPEND_BARS.map((h, i) => (
                <div
                  // eslint-disable-next-line react/no-array-index-key -- static sample bars
                  key={i}
                  className="flex h-full flex-1 flex-col items-center justify-end gap-2"
                >
                  <div
                    className="w-full rounded-t-sm"
                    style={{
                      height: `${h}%`,
                      background:
                        i === SPEND_BARS.length - 1 ? "var(--flame-500)" : "var(--flame-200)",
                    }}
                  />
                  <span className="fg-caption font-mono text-subtle">
                    {(i + 1) % 5 === 0 ? i + 1 : ""}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* By project */}
          <Card>
            <PanelHead title="By project" ct="this month" />
            <div className="px-[18px] pb-3.5 pt-1.5">
              {BY_PROJECT.map((r) => (
                <BreakRow key={r.name} {...r} />
              ))}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          {/* By model */}
          <Card>
            <PanelHead title="By model" />
            <div className="px-[18px] pb-3.5 pt-1.5">
              {BY_MODEL.map((r) => (
                <BreakRow key={r.name} {...r} nameWidth={96} />
              ))}
            </div>
          </Card>

          {/* By stage */}
          <Card>
            <PanelHead title="By stage" />
            <div className="px-[18px] pb-3.5 pt-1.5">
              {BY_STAGE.map((r) => (
                <BreakRow key={r.name} {...r} nameWidth={96} />
              ))}
            </div>
          </Card>

          {/* Monthly budget */}
          <Card>
            <PanelHead title="Monthly budget" />
            <div className="px-[18px] py-3.5">
              <div className="mb-2.5 flex justify-between font-mono text-xs text-muted">
                <span>
                  Used <b className="text-fg">$387.10</b>
                </span>
                <span>$700.00</span>
              </div>
              <span className="block h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
                <span
                  className="block h-full rounded-pill"
                  style={{ width: "55%", background: "var(--flame-500)" }}
                />
              </span>
              <p className="fg-body-sm mt-2.5 text-subtle">
                On track to hit ~$612 by month end · alert at 90%
              </p>
            </div>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
