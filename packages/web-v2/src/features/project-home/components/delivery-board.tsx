// The Delivery drawer's picture: the open issues on a small board, one column per where they stand,
// each card its title (whole on hover), a High mark where it is urgent, how far along build → test →
// release it is, and its age. A column counts every issue it holds, though it names at most a few.

import type { HomeDelivery, HomeIssue } from "@forge/contracts/project-home";
import { Badge, Tooltip } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { issueHref, issuesHref } from "@/lib/routes/issues";
import { boardOf, DELIVERY_COLUMNS, isHighPriority, SERIES, trackOf } from "../model";

/** The cards one column names; the rest are counted in its header and open on the Issues page. */
const COLUMN_CARDS = 6;
const STEPS = ["home.step.build", "home.step.test", "home.step.release"] as const;

function Track({ lit }: { lit: number }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {STEPS.map((s, i) => (
        <span key={s} className="h-1 w-3 rounded-pill" style={{ background: i < lit ? "var(--chart-2)" : "var(--bg-active)" }} />
      ))}
    </span>
  );
}

function Card({ issue, slug }: { issue: HomeIssue; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const lit = trackOf(issue);
  return (
    <Link href={issueHref(slug, issue.key)} className="block rounded-md bg-surface px-2.5 py-2 text-fg transition-colors hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none" data-testid="home-issue-card">
      <Tooltip label={issue.title} multiline className="w-full">
        <span className="line-clamp-2 text-13">{issue.title}</span>
      </Tooltip>
      <span className="mt-1.5 flex items-center gap-2 text-12 text-subtle">
        {isHighPriority(issue.priority) ? <Badge tone="red">{t("home.priority.high")}</Badge> : null}
        <Track lit={lit} />
        {lit > 0 ? <span>{t(STEPS[lit - 1] ?? "home.step.build")}</span> : null}
        <span className="ml-auto tabular-nums" title={time.dateTime(issue.touchedAt)}>
          {time.age(issue.touchedAt)}
        </span>
      </span>
    </Link>
  );
}

export function DeliveryBoard({ delivery, slug }: { delivery: HomeDelivery; slug: string }) {
  const t = useCopy();
  const board = boardOf(delivery.issues);
  const counts = new Map(delivery.byStatus.map((c) => [c.key, c.count]));
  const columns = DELIVERY_COLUMNS.map((c, at) => ({ ...c, fill: SERIES[at % SERIES.length], count: c.of.reduce((n, s) => n + (counts.get(s) ?? 0), 0), cards: board.get(c.key) ?? [] }))
    // the queue shows only while it holds work: an empty one says nothing the three columns do not
    .filter((c) => c.key !== "queued" || c.count > 0);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="home-board">
      {columns.map((c) => (
        <section key={c.key} aria-label={t(c.label)} className="flex min-w-0 flex-col gap-1.5 bg-sunken p-2" data-testid={`home-board-${c.key}`}>
          <h3 className="flex items-center gap-1.5 text-12 font-semibold text-muted">
            <span aria-hidden className="size-2 rounded-sm" style={{ background: c.fill }} />
            {t(c.label)}
            <b className="ml-auto tabular-nums text-fg">{c.count}</b>
          </h3>
          {c.cards.length === 0 ? <p className="px-0.5 text-12 text-subtle">{t("home.none")}</p> : null}
          {c.cards.slice(0, COLUMN_CARDS).map((i) => (
            <Card key={i.key} issue={i} slug={slug} />
          ))}
          {c.count > Math.min(c.cards.length, COLUMN_CARDS) ? (
            <Link href={issuesHref(slug)} className="px-0.5 text-12 text-muted hover:text-fg">
              {t("dash.more", { n: c.count - Math.min(c.cards.length, COLUMN_CARDS) })}
            </Link>
          ) : null}
        </section>
      ))}
    </div>
  );
}
