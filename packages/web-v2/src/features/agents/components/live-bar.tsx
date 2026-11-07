// The bar on every project page that says what runs on the project now (REQ-15 BC-10, ISS-856): the
// master, the runs and jobs in flight, releases and deploys, and the support rooms' turns, one line
// collapsed and a short flat list open, each item a link. A build a lease holds with no run over it
// (a direct-mode master's, ISS-1102) is running too, said as the master's where core says it is. It reads the run standing and the rooms'
// turns once and again only when a project-room frame says they moved; it never polls. Its face is
// plain words in the person's language (ISS-864, `ui-copy-rule` 10): an issue's title, never its key;
// keys, room ids, steps and boxes sit in each item's tooltip and behind its link.
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { LiveDot, Tooltip, useNow } from "@/design";
import { formatClock, formatElapsed } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import { Link } from "@/lib/navigation/router";
import { masterHref, runHref } from "@/lib/routes/agents";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { type NowItem, type ProjectNow, projectNowOf, type Read } from "../now";
import { nowQueries } from "../queries";
import type { RunLeasedBuild, RunStanding } from "../types";

/** How many items the collapsed line names before it counts the rest. */
const LINE_ITEMS = 3;
/** Elapsed times move by the minute; the clock is local and reads nothing. */
const TICK_MS = 30_000;

const readOfQuery = <T,>(q: UseQueryResult<T>): Read<T> =>
  q.isError ? { state: "unreadable" } : q.data === undefined ? { state: "loading" } : { state: "read", data: q.data };

const channelHref = (slug: string, rid: string) => `/projects/${encodeURIComponent(slug)}/channels/${encodeURIComponent(rid)}`;

/** The identifiers an item keeps off its face, for its tooltip. */
const tipOf = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

interface Row {
  key: string;
  text: string;
  href: string;
  tip: string;
  since: string | null;
}

type Language = ReturnType<typeof useInterfaceLanguage>;
type Label = ReturnType<typeof useLabel>;

function runRow(r: RunStanding, t: Copy, label: Label, language: Language, slug: string): Row {
  const title = r.issue?.title ?? said(r.says.title, language);
  const step = r.step.source === "work_state" ? label("workStep", r.step.step) : null;
  return {
    key: r.id,
    text: step ? t("agents.now.run", { step, title }) : title,
    href: r.issue ? issueHref(slug, r.issue.key) : runHref(slug, r.id),
    tip: tipOf(r.issue?.key, r.step.step, r.device?.name),
    since: r.startedAt,
  };
}

function leasedRow(b: RunLeasedBuild, t: Copy, label: Label, slug: string): Row {
  const title = b.issue.title;
  const step = b.step ? label("workStep", b.step) : null;
  const text = b.byMaster
    ? step
      ? t("agents.now.leased.master", { step, title })
      : t("agents.now.leased.masterAny", { title })
    : step
      ? t("agents.now.run", { step, title })
      : title;
  return { key: `leased:${b.issue.key}`, text, href: issueHref(slug, b.issue.key), tip: tipOf(b.issue.key, b.step, b.holder), since: b.stepStartedAt };
}

type MasterItem = Extract<NowItem, { kind: "master" }>;

/** The master's line, carrying the step, box and start of the run or leased build on its issue. */
function masterRow(item: MasterItem, folded: NowItem | undefined, t: Copy, slug: string): Row {
  const fold = folded?.kind === "run" ? folded.run : null;
  const lease = folded?.kind === "leased" ? folded.build : null;
  const title = item.issue?.title ?? null;
  return {
    key: "master",
    text: item.word === "working" && title ? t("agents.now.master.on", { title }) : t(`agents.now.master.${item.word}`),
    href: item.issue ? issueHref(slug, item.issue.key) : masterHref(slug),
    tip: tipOf(item.issue?.key, fold?.step.step ?? lease?.step, fold?.device?.name ?? lease?.holder ?? item.box),
    since: fold?.startedAt ?? lease?.stepStartedAt ?? null,
  };
}

function rowsOf(now: ProjectNow, t: Copy, label: Label, language: Language, slug: string): Row[] {
  const master = now.items.find((i) => i.kind === "master");
  const masterKey = master?.issue?.key ?? null;
  // a run or a leased build on the issue the master works is the master's work: said once, on the master's line
  const folded = now.items.find(
    (i) => masterKey !== null && ((i.kind === "run" && i.run.issue?.key === masterKey) || (i.kind === "leased" && i.build.issue.key === masterKey)),
  );
  const rowOf = (item: NowItem): Row | null => {
    switch (item.kind) {
      case "master":
        return item.word === "idle" ? null : masterRow(item, folded, t, slug);
      case "run":
        return item === folded ? null : runRow(item.run, t, label, language, slug);
      case "leased":
        return item === folded ? null : leasedRow(item.build, t, label, slug);
      case "release": {
        const r = item.run;
        const version = r.release?.version ?? null;
        return {
          key: r.id,
          text: version ? t("agents.now.releasing", { v: version }) : t("agents.now.releasingAny"),
          href: version ? releaseHref(slug, version) : runHref(slug, r.id),
          tip: tipOf(r.release?.stage ?? r.step.step, r.device?.name),
          since: r.startedAt,
        };
      }
      case "deploy": {
        const r = item.run;
        const lock = r.deployLocks[0];
        return {
          key: r.id,
          text: lock ? t("agents.now.deploying", { env: lock.environment }) : t("agents.now.deployingAny"),
          href: runHref(slug, r.id),
          tip: tipOf(lock?.subject, r.device?.name),
          since: r.startedAt,
        };
      }
      case "answering":
        return {
          key: "answering",
          text: item.rooms.length === 1 ? t("agents.now.answering") : t("agents.now.answeringIn", { n: item.rooms.length }),
          href: channelHref(slug, item.rooms[0]?.rid ?? ""),
          tip: tipOf(...item.rooms.map((r) => r.rid)),
          since: null,
        };
      case "waiting":
        return {
          key: "waiting",
          text: item.messages === 1 ? t("agents.now.waitingOne") : t("agents.now.waiting", { n: item.messages }),
          href: channelHref(slug, item.rooms[0]?.rid ?? ""),
          tip: tipOf(...item.rooms.map((r) => r.rid)),
          since: item.since,
        };
    }
  };
  return now.items.map(rowOf).filter((r): r is Row => r !== null);
}

// an item, the tooltip wrapping its link and the link are bounded by the bar, never by their text: a
// long issue title at phone width truncates inside the screen instead of pushing every page sideways
function RowLine({ row, at }: { row: Row; at: number }) {
  const language = useInterfaceLanguage();
  const link = (
    <Link href={row.href} className="block min-w-0 max-w-full truncate font-medium text-link hover:underline sm:max-w-md">
      {row.text}
    </Link>
  );
  return (
    <>
      {row.tip ? (
        <Tooltip label={row.tip} className="min-w-0 max-w-full">
          {link}
        </Tooltip>
      ) : (
        link
      )}
      {row.since ? <span className="text-muted tabular-nums">{formatElapsed(at - Date.parse(row.since), language)}</span> : null}
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
  const label = useLabel();
  const rows = rowsOf(now, t, label, language, slug);
  const quiet = !now.busy && !now.loading && now.unreadable.length === 0;
  const line = rows.slice(0, LINE_ITEMS);
  const rest = rows.length - line.length;
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
            {t(`agents.now.cantRead.${source}`)}
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
          <span key={row.key} className="inline-flex min-w-0 max-w-full items-center gap-1.5" data-testid="live-bar-item">
            <RowLine row={row} at={at} />
          </span>
        ))}
        {rest > 0 ? <span className="text-muted">{t("agents.now.more", { n: rest })}</span> : null}
        {rows.length > LINE_ITEMS ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ml-auto text-muted hover:underline">
            {open ? t("agents.now.collapse") : t("agents.now.expand")}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul data-testid="live-bar-list" className="border-t border-line px-4 py-1">
          {rows.map((row) => (
            <li key={row.key} className="flex min-w-0 flex-wrap items-center gap-x-3 py-0.5">
              <RowLine row={row} at={at} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
