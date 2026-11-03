// Moving (ISS-919): each item the person gave or owns that is not live yet and that someone else owes,
// at its stage, with who owes the next move and the forecast's held date, or the words saying none is
// held. Core ranks it by last move; what nothing has moved for a week folds under one Idle row, each
// with its age. A list core cut says how many it holds of how many, so it never reads as complete.

import { Button, LiveDot, SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { HOME_ROWS, itemHref, movingSplit, STAGE_TONE } from "../home-rows";
import { CutNote } from "./cut-note";
import { ShowMore } from "./show-more";
import type { HomeMovingItem } from "../types";

export interface MovingWorkProps {
  items: HomeMovingItem[];
  /** How many moving items core counted before its cut. */
  total: number;
  truncated: boolean;
}

export function MovingWork({ items, total, truncated }: MovingWorkProps) {
  const t = useCopy();
  const [all, setAll] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const { active, idle } = movingSplit(items);
  const shown = all ? active : active.slice(0, HOME_ROWS);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-moving" data-testid="home-moving">
      <SectionTitle id="home-moving" className="fg-h3">{t("overview.home.moving.title")}</SectionTitle>
      {items.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("overview.home.moving.empty")}</p>
      ) : (
        <>
        {shown.length > 0 ? <MovingTable items={shown} /> : null}
        <ShowMore hidden={active.length - shown.length} onShow={() => setAll(true)} />
        {idle.length > 0 ? (
          <>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={idleOpen}
            data-testid="home-moving-idle"
            onClick={() => setIdleOpen((o) => !o)}
          >
            {t("overview.home.idle", { n: idle.length })}
          </Button>
          {idleOpen ? <MovingTable items={idle} idle /> : null}
          </>
        ) : null}
        {truncated ? <CutNote shown={items.length} total={total} /> : null}
        </>
      )}
    </section>
  );
}

function MovingTable({ items, idle = false }: { items: HomeMovingItem[]; idle?: boolean }) {
  const t = useCopy();
  return (
    <Table aria-labelledby="home-moving" data-testid={idle ? "home-moving-idle-list" : undefined}>
      <THead className="sr-only">
        <TR>
          <TH>{t("overview.home.col.item")}</TH>
          <TH className="max-sm:hidden">{t("overview.home.col.project")}</TH>
          <TH>{t("overview.home.col.status")}</TH>
          <TH>{t("overview.home.col.next")}</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((m) => (
          <MovingItem key={`${m.projectSlug}:${m.key}`} item={m} />
        ))}
      </TBody>
    </Table>
  );
}

function MovingItem({ item }: { item: HomeMovingItem }) {
  const t = useCopy();
  const time = useTimeFormat();
  const owes = item.owes
    ? item.owes.act
      ? t("overview.home.owes", { who: item.owes.who, act: item.owes.act })
      : item.owes.who
    : t("overview.home.nobody");
  return (
    <TR data-testid="home-moving-row" className="max-sm:flex max-sm:flex-wrap max-sm:items-center" data-stage={item.stage} data-idle={item.idle || undefined}>
      <TD className="max-sm:basis-full max-sm:pb-0 sm:w-full sm:max-w-0">
        <Link href={itemHref(item)} title={`${item.key} · ${item.title}`} className="line-clamp-1 hover:underline sm:block sm:truncate">
          {item.title}
        </Link>
      </TD>
      <TD className="text-muted max-sm:hidden sm:w-px sm:whitespace-nowrap">{item.projectName}</TD>
      <TD className="sm:w-px sm:whitespace-nowrap">
        <span className="inline-flex items-center gap-2">
          <StatusChip tone={STAGE_TONE[item.stage]} label={t(`overview.home.stage.${item.stage}`)} />
          {item.running ? (
            <span className="inline-flex" title={t("overview.home.runningNow")}>
              <LiveDot state="live" />
              <span className="sr-only">{t("overview.home.runningNow")}</span>
            </span>
          ) : null}
        </span>
      </TD>
      <TD className="sm:w-px sm:whitespace-nowrap">
        <span className="block">{owes}</span>
        {item.idle ? (
          <span className="block text-12 text-muted" data-testid="home-moving-age" title={time.dateTime(item.lastMovedAt)}>
            {time.relative(item.lastMovedAt)}
          </span>
        ) : (
          <span className="block text-12 text-muted" data-testid="home-moving-date" title={item.noDate ?? undefined}>
            {item.likelyBy ? t("overview.home.by", { date: time.date(item.likelyBy) }) : t("overview.home.noDate")}
          </span>
        )}
      </TD>
    </TR>
  );
}
