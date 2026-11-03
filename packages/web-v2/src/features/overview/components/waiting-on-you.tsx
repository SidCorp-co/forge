// Waiting on you (ISS-919): the needs-you read behind /attention, decisions first, then the person's
// own items whose next move is theirs (the home read's `waiting`, deduped by key); each row's next step
// is the act itself, opening the place that takes it. Decisions core counted past its cap are said.

import { Button, SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useAttention } from "@/features/attention";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link, useRouter } from "@/lib/navigation/router";
import { useState } from "react";
import { decisionsNotSent, HOME_ROWS, type WaitingRow, waitingRows } from "../home-rows";
import type { HomeWaitingItem } from "../types";
import { CutNote } from "./cut-note";
import { ShowMore } from "./show-more";

export function WaitingOnYou({ owed }: { owed: readonly HomeWaitingItem[] }) {
  const t = useCopy();
  const q = useAttention();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-waiting" data-testid="home-waiting">
      <SectionTitle id="home-waiting" className="fg-h3">{t("overview.home.waiting.title")}</SectionTitle>
      <QueryBoundary query={{ ...q, data: q.view }} loadingLabel={t("overview.home.loading")} height="inline">
        {(view) => {
          const rows = waitingRows(view, owed);
          if (rows.length === 0) return <p className="fg-body-sm text-muted">{t("overview.home.waiting.empty")}</p>;
          return (
            <>
            <WaitingTable rows={rows} />
            <CutNote shown={rows.length} total={rows.length + decisionsNotSent(view)} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

function WaitingTable({ rows }: { rows: WaitingRow[] }) {
  const t = useCopy();
  const router = useRouter();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, HOME_ROWS);
  return (
    <>
    <Table aria-labelledby="home-waiting">
      <THead className="sr-only">
        <TR>
          <TH>{t("overview.home.col.item")}</TH>
          <TH className="max-sm:hidden">{t("overview.home.col.project")}</TH>
          <TH>{t("overview.home.col.status")}</TH>
          <TH>{t("overview.home.col.next")}</TH>
        </TR>
      </THead>
      <TBody>
        {shown.map((r) => (
          <TR key={r.id} data-testid="home-waiting-row" className="max-sm:flex max-sm:flex-wrap max-sm:items-center">
            <TD className="max-sm:basis-full max-sm:pb-0 sm:w-full sm:max-w-0">
              <Link href={r.href} title={r.tip ? `${r.tip} · ${r.title}` : r.title} className="line-clamp-1 hover:underline sm:block sm:truncate">
                {r.title}
              </Link>
            </TD>
            <TD className="text-muted max-sm:hidden sm:w-px sm:whitespace-nowrap">{r.projectName}</TD>
            <TD className="sm:w-px sm:whitespace-nowrap">
              <span className="inline-flex" title={r.owes ?? undefined}>
                <StatusChip tone="you" label={t(`overview.home.kind.${r.kind}`)} />
              </span>
            </TD>
            <TD className="sm:w-px sm:whitespace-nowrap">
              <Button size="sm" onClick={() => router.push(r.href)}>
                {t(`overview.home.act.${r.act}`)}
              </Button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
    <ShowMore hidden={rows.length - shown.length} onShow={() => setAll(true)} />
    </>
  );
}
