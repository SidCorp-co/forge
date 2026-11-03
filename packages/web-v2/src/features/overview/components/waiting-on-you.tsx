// Waiting on you (ISS-919): the needs-you read behind /attention, decisions first; each row's next
// step is the act itself, opening the place that takes it.

import { Button, SectionTitle, StatusChip, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useAttention } from "@/features/attention";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link, useRouter } from "@/lib/navigation/router";
import { type WaitingRow, waitingBeyond, waitingRows } from "../home-rows";

export function WaitingOnYou() {
  const t = useCopy();
  const q = useAttention();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="home-waiting" data-testid="home-waiting">
      <SectionTitle id="home-waiting" className="fg-h3">{t("overview.home.waiting.title")}</SectionTitle>
      <QueryBoundary query={{ ...q, data: q.view }} loadingLabel={t("overview.home.loading")} height="inline">
        {(view) => {
          const rows = waitingRows(view);
          const more = waitingBeyond(view);
          if (rows.length === 0) return <p className="fg-body-sm text-muted">{t("overview.home.waiting.empty")}</p>;
          return (
            <>
              <WaitingTable rows={rows} />
              {more > 0 ? <p className="fg-caption text-muted">{t("overview.home.waiting.more", { n: more })}</p> : null}
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
  return (
    <Table aria-labelledby="home-waiting">
      <THead>
        <TR>
          <TH>{t("overview.home.col.item")}</TH>
          <TH className="max-sm:hidden">{t("overview.home.col.project")}</TH>
          <TH>{t("overview.home.col.status")}</TH>
          <TH>{t("overview.home.col.next")}</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id} data-testid="home-waiting-row">
            <TD>
              <Link href={r.href} title={r.tip ?? undefined} className="line-clamp-2 hover:underline">
                {r.title}
              </Link>
            </TD>
            <TD className="text-muted max-sm:hidden">{r.projectName}</TD>
            <TD>
              <StatusChip tone="you" label={t(`overview.home.kind.${r.kind}`)} />
            </TD>
            <TD>
              <Button size="sm" onClick={() => router.push(r.href)}>
                {t(`overview.home.act.${r.act}`)}
              </Button>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
