// The Release drawer's picture: the last fourteen days as a line, one dot per release shipped, sized
// by the issues it carried and named on hover; then the newest releases that shipped, the Shipped
// list the home used to show.

import type { HomeRelease, HomeReleaseStage } from "@forge/contracts/project-home";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { releaseHref } from "@/lib/routes/releases";
import { dayLabel } from "../model";

const W = 560;
const H = 132;
const AXIS_Y = H - 22;
const LANES = 5;

/** A release's lane: spread so dots of one day sit apart, the same lane on every draw. */
const laneOf = (version: string) => [...version].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % LANES;

/** Local midnight of a `YYYY-MM-DD` key: the read counts days in the reader's own zone, as the browser does. */
const midnightOf = (key: string) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};

function Timeline({ stage }: { stage: HomeReleaseStage }) {
  const t = useCopy();
  const time = useTimeFormat();
  const first = stage.days[0]?.day;
  if (!first) return null;
  const start = midnightOf(first);
  const span = stage.days.length * 86_400_000;
  const xAt = (share: number) => 8 + (W - 16) * Math.min(Math.max(share, 0), 1);
  return (
    <figure className="m-0" data-testid="home-release-timeline">
      <figcaption className="pb-1 text-12 text-subtle">{t("home.release.timeline")}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t("home.release.timelineAlt", { n: stage.shipped, m: stage.issues })}>
        <line x1={8} x2={W - 8} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--border-strong)" />
        {stage.days.map((d, i) => {
          const x = xAt(i / stage.days.length);
          return (
            <g key={d.day}>
              <line x1={x} x2={x} y1={6} y2={AXIS_Y} stroke="var(--border-divider)" />
              {i % 2 === 0 ? (
                <text x={x + 3} y={H - 6} fontSize="11" fill="var(--fg-subtle)">
                  {dayLabel(d.day)}
                </text>
              ) : null}
            </g>
          );
        })}
        {[...stage.timeline]
          .sort((a, b) => b.issueCount - a.issueCount)
          .map((r) => (
            <circle
              key={r.version}
              cx={xAt((Date.parse(r.releasedAt) - start) / span)}
              cy={14 + ((AXIS_Y - 28) * laneOf(r.version)) / (LANES - 1)}
              r={2.5 + 1.6 * Math.sqrt(r.issueCount)}
              fill="var(--chart-2)"
              fillOpacity={0.6}
              stroke="var(--bg-surface)"
              strokeWidth={1.5}
              data-testid="home-release-dot"
            >
              <title>{t("home.release.dot", { name: r.name ?? t("home.release.unnamed"), n: r.issueCount, at: time.shortDateTime(r.releasedAt) })}</title>
            </circle>
          ))}
      </svg>
    </figure>
  );
}

function Shipped({ releases, slug }: { releases: readonly HomeRelease[]; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <section aria-label={t("home.release.shipped")} data-testid="home-shipped">
      <h3 className="pb-1 text-12 font-semibold text-muted">{t("home.release.shipped")}</h3>
      {releases.length === 0 ? <p className="text-13 text-subtle">{t("home.none")}</p> : null}
      <ul className="m-0 list-none divide-y divide-line-divider p-0">
        {releases.map((r) => (
          <li key={r.version}>
            <Link href={releaseHref(slug, r.version)} className="flex items-center gap-3 py-2 text-13 text-fg hover:bg-hover">
              <span className="min-w-0 flex-1 truncate" title={r.name ?? r.version}>
                {r.name ?? r.version}
              </span>
              <span className="flex-none text-12 text-subtle">{t("home.release.issues", { n: r.issueCount })}</span>
              <span className="flex-none text-12 tabular-nums text-subtle" title={time.dateTime(r.releasedAt)}>
                {time.age(r.releasedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReleaseDrawerBody({ stage, slug }: { stage: HomeReleaseStage; slug: string }) {
  return (
    <div className="flex flex-col gap-5">
      <Timeline stage={stage} />
      <Shipped releases={stage.recent} slug={slug} />
    </div>
  );
}
