// Moving (ISS-919): each item the person gave or owns that is not live yet, at its stage, with who
// owes the next move and the forecast's held date, or the words saying none is held.

import { LiveDot, SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { itemHref, STAGE_TONE } from "../home-rows";
import type { HomeMovingItem } from "../types";

export function MovingWork({ items }: { items: HomeMovingItem[] }) {
  const t = useCopy();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-moving" data-testid="home-moving">
      <SectionTitle id="home-moving" className="fg-h3">{t("overview.home.moving.title")}</SectionTitle>
      {items.length === 0 ? (
        <p className="fg-body-sm text-muted">{t("overview.home.moving.empty")}</p>
      ) : (
        <Table aria-labelledby="home-moving">
          <THead>
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
    <TR data-testid="home-moving-row" data-stage={item.stage}>
      <TD>
        <Link href={itemHref(item)} title={item.key} className="line-clamp-2 hover:underline">
          {item.title}
        </Link>
      </TD>
      <TD className="text-muted max-sm:hidden">{item.projectName}</TD>
      <TD>
        <span className="inline-flex items-center gap-2">
          <StatusChip tone={STAGE_TONE[item.stage]} label={t(`overview.home.stage.${item.stage}`)} />
          {item.running ? <LiveDot state="live" withLabel /> : null}
        </span>
      </TD>
      <TD>
        <span className="block">{owes}</span>
        <span className="block text-12 text-muted" data-testid="home-moving-date" title={item.noDate ?? undefined}>
          {item.likelyBy ? t("overview.home.by", { date: time.date(item.likelyBy) }) : t("overview.home.noDate")}
        </span>
      </TD>
    </TR>
  );
}
