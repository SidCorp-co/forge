// The bar on every project page that says what runs on the project now (REQ-15 BC-10, ISS-856): the
// master, the runs and jobs in flight, releases and deploys, and the support rooms' turns, one line
// collapsed and a short flat list open, each item a link. It reads the run standing and the rooms'
// turns once and again only when a project-room frame says they moved; it never polls.
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { LiveDot, useNow } from "@/design";
import { formatClock, formatElapsed } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { Link } from "@/lib/navigation/router";
import { masterHref, runHref } from "@/lib/routes/agents";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { type NowItem, type ProjectNow, projectNowOf, type Read } from "../now";
import { nowQueries } from "../queries";
import type { RunStanding } from "../types";

/** How many items the collapsed line names before it counts the rest. */
const LINE_ITEMS = 3;
/** Elapsed times move by the minute; the clock is local and reads nothing. */
const TICK_MS = 30_000;

const readOfQuery = <T,>(q: UseQueryResult<T>): Read<T> =>
  q.isError ? { state: "unreadable" } : q.data === undefined ? { state: "loading" } : { state: "read", data: q.data };

const channelHref = (slug: string, rid: string) => `/projects/${encodeURIComponent(slug)}/channels/${encodeURIComponent(rid)}`;

interface Row {
  key: string;
  label: string;
  href: string;
  detail: string | null;
  since: string | null;
  box: string | null;
  issue?: { key: string; href: string };
}

function useRows(now: ProjectNow, slug: string): Row[] {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const runDetail = (r: RunStanding) => r.step.step ?? r.lane;
  const rowOf = (item: NowItem): Row => {
    switch (item.kind) {
      case "master":
        return {
          key: "master",
          label: t("agents.now.master"),
          href: masterHref(slug),
          detail: t(`agents.now.master.${item.word}`),
          since: null,
          box: null,
          ...(item.issueKey ? { issue: { key: item.issueKey, href: issueHref(slug, item.issueKey) } } : {}),
        };
      case "run": {
        const r = item.run;
        return {
          key: r.id,
          label: r.issue?.key ?? said(r.says.title, language),
          href: r.issue ? issueHref(slug, r.issue.key) : runHref(slug, r.id),
          detail: runDetail(r),
          since: r.startedAt,
          box: r.device?.name ?? null,
        };
      }
      case "release": {
        const r = item.run;
        const version = r.release?.version ?? null;
        return {
          key: r.id,
          label: version ? t("agents.now.release", { v: version }) : t("agents.now.releaseBatch"),
          href: version ? releaseHref(slug, version) : runHref(slug, r.id),
          detail: r.release?.stage ?? runDetail(r),
          since: r.startedAt,
          box: r.device?.name ?? null,
        };
      }
      case "deploy": {
        const r = item.run;
        const lock = r.deployLocks[0];
        return {
          key: r.id,
          label: lock ? t("agents.now.deploy", { subject: lock.subject, env: lock.environment }) : said(r.says.title, language),
          href: runHref(slug, r.id),
          detail: runDetail(r),
          since: r.startedAt,
          box: r.device?.name ?? null,
        };
      }
      case "room": {
        const room = item.room;
        return {
          key: room.roomId,
          label: t("agents.now.room", { rid: room.rid }),
          href: channelHref(slug, room.rid),
          detail: room.state === "answering" ? t("agents.now.room.answering") : t("agents.now.room.waiting", { n: room.waiting }),
          since: room.state === "waiting" ? room.waitingSince : null,
          box: null,
        };
      }
    }
  };
  return now.items.map(rowOf);
}

function RowLine({ row, at }: { row: Row; at: number }) {
  const language = useInterfaceLanguage();
  return (
    <>
      <Link href={row.href} className="font-medium text-link hover:underline">
        {row.label}
      </Link>
      {row.detail ? <span className="text-muted">{row.detail}</span> : null}
      {row.issue ? (
        <Link href={row.issue.href} className="font-mono hover:underline">
          {row.issue.key}
        </Link>
      ) : null}
      {row.since ? <span className="text-muted tabular-nums">{formatElapsed(at - Date.parse(row.since), language)}</span> : null}
      {row.box ? <span className="text-muted">{row.box}</span> : null}
    </>
  );
}

export function LiveBar({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [open, setOpen] = useState(false);
  const at = useNow(TICK_MS);
  useRoom(projectRoom(projectId));
  const live = useQuery(nowQueries.live(projectId));
  const recent = useQuery(nowQueries.recent(projectId));
  const rooms = useQuery(nowQueries.rooms(projectId));
  const now = projectNowOf(readOfQuery(live), readOfQuery(recent), readOfQuery(rooms));
  const rows = useRows(now, slug);
  const quiet = !now.busy && !now.loading && now.unreadable.length === 0;
  const shown = quiet ? rows.filter((r) => r.key === "master") : rows;
  const line = shown.slice(0, LINE_ITEMS);
  const rest = shown.length - line.length;
  return (
    <section
      aria-label={t("agents.now.region")}
      data-testid="live-bar"
      data-state={now.unreadable.length > 0 ? "unreadable" : now.loading ? "loading" : quiet ? "quiet" : "busy"}
      className="sticky top-0 z-20 border-b border-line bg-app text-12"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1">
        <LiveDot state={now.busy ? "live" : "offline"} />
        {now.unreadable.map((source) => (
          <span key={source} data-testid={`live-bar-unreadable-${source}`} className="text-danger">
            {t("agents.now.cantRead", { source: t(`agents.now.source.${source}`) })}
          </span>
        ))}
        {now.loading && now.unreadable.length === 0 ? <span className="text-muted">{t("agents.now.reading")}</span> : null}
        {quiet ? (
          <span data-testid="live-bar-nothing">
            {t("agents.now.nothing")} ·{" "}
            <span className="text-muted">
              {now.lastActivityAt ? t("agents.now.lastActivity", { at: formatClock(now.lastActivityAt, language) }) : t("agents.now.noActivity")}
            </span>
          </span>
        ) : null}
        {line.map((row) => (
          <span key={row.key} className="inline-flex items-center gap-1.5" data-testid="live-bar-item">
            <RowLine row={row} at={at} />
          </span>
        ))}
        {rest > 0 ? <span className="text-muted">{t("agents.now.more", { n: rest })}</span> : null}
        {shown.length > LINE_ITEMS ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ml-auto text-muted hover:underline">
            {open ? t("agents.now.collapse") : t("agents.now.expand")}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul data-testid="live-bar-list" className="border-t border-line px-4 py-1">
          {shown.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 py-0.5">
              <RowLine row={row} at={at} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
