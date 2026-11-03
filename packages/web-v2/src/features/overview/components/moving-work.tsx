// Moving (ISS-919): each item the person gave or owns that is not live yet, at its stage, with who
// owes the next move and the forecast's held date, or the words saying none is held.

import { LiveDot, SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { HOME_ROWS, itemHref, STAGE_TONE } from "../home-rows";
import { ShowMore } from "./show-more";
import type { HomeMovingItem } from "../types";

export function MovingWork({ items }: { items: HomeMovingItem[] }) {
  const t = useCopy();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, HOME_ROWS);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-moving" data-testid="home-moving">
      <SectionTitle id="home-moving" className="fg-h3">{t("overview.home.moving.title")}</SectionTitle>
      {items.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("overview.home.moving.empty")}</p>
      ) : (
        <>
        <Table aria-labelledby="home-moving">
          <THead className="sr-only">
            <TR>
              <TH>{t("overview.home.col.item")}</TH>
              <TH className="max-sm:hidden">{t("overview.home.col.project")}</TH>
              <TH>{t("overview.home.col.status")}</TH>
              <TH>{t("overview.home.col.next")}</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((m) => (
              <MovingItem key={`${m.projectSlug}:${m.key}`} item={m} />
            ))}
          </TBody>
        </Table>
        <ShowMore hidden={items.length - shown.length} onShow={() => setAll(true)} />
        </>
      )}
    </section>
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
    <TR data-testid="home-moving-row" className="max-sm:flex max-sm:flex-wrap max-sm:items-center" data-stage={item.stage}>
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
        <span className="block text-12 text-muted" data-testid="home-moving-date" title={item.noDate ?? undefined}>
          {item.likelyBy ? t("overview.home.by", { date: time.date(item.likelyBy) }) : t("overview.home.noDate")}
        </span>
      </TD>
    </TR>
  );
}
