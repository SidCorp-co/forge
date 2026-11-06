// A project's cleanup in its Activity peek (ISS-1051, REQ-79 BC-22): one compact row saying whether
// its cleanup window is on and when it next runs, with its open debt counted, and two rows that open
// on demand: its last report (what it cleared and what remains) and the open debt itself. Read from
// the project's own ledger and reports, only while the peek is open. Debt is named by where it is,
// never by its id; why it remains, or what it is, is the row's tooltip.

import type { CleanupReportView, DebtLedgerView, DebtView } from "@forge/contracts/cleanup";
import type { ReactNode } from "react";
import { LEGEND, RowItem, RowList } from "@/design";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import { formatAge } from "@/lib/utils/format";
import { useProjectCleanup } from "../hooks";

/** A row that opens on demand, as the peek's Recent does. */
function Fold({ label, testId, trailing, children }: { label: string; testId: string; trailing: ReactNode; children: ReactNode }) {
  return (
    <details className="group border-b border-line-divider" data-testid={testId}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-13 text-fg hover:bg-hover">
        <span className="truncate">{label}</span>
        <span className="flex flex-none items-center gap-2">{trailing}</span>
      </summary>
      <div className="pb-1 pl-3">{children}</div>
    </details>
  );
}

/** Each debt a report or the ledger names, by where it is; what is known of it on hover. A list in a report says once what it is. */
function DebtRows({ label, heading, rows }: { label: string; heading: boolean; rows: { key: string; where: string; tip: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      {heading ? (
        <p className="flex items-baseline gap-1.5 px-3 pt-2 text-11-5 font-semibold uppercase tracking-wide text-subtle">
          {label}
          <span className="font-mono normal-case tracking-normal">{rows.length}</span>
        </p>
      ) : null}
      <RowList label={label}>
        {rows.map((r) => (
          <RowItem key={r.key} rowKey={r.key} title={r.where} tip={r.tip} />
        ))}
      </RowList>
    </>
  );
}

function Report({ report, debts, now }: { report: CleanupReportView; debts: Map<string, DebtView>; now: number }) {
  const t = useCopy();
  const named = (id: string) => debts.get(id)?.where ?? t("activity.cleanup.debtGone");
  const green = report.result === "green";
  return (
    <Fold
      label={t("activity.cleanup.lastReport")}
      testId="cleanup-report"
      trailing={
        <>
          <span className="text-12 font-medium" style={{ color: green ? LEGEND.ready.fg : LEGEND.err.fg }}>
            {t(`activity.cleanup.result.${report.result}`)}
          </span>
          <span className="font-mono text-11-5 text-subtle" title={new Date(report.reportedAt).toLocaleString()}>
            {formatAge(report.reportedAt, now)}
          </span>
        </>
      }
    >
      <DebtRows heading label={t("activity.cleanup.cleared")} rows={report.cleared.map((c) => ({ key: `c:${c.debt}`, where: named(c.debt), tip: c.how }))} />
      <DebtRows heading label={t("activity.cleanup.remains")} rows={report.remains.map((r) => ({ key: `r:${r.debt}`, where: named(r.debt), tip: r.why }))} />
    </Fold>
  );
}

/** Whether the window is on, and when it next runs; why it is off, and who turns it on, on hover. */
function Window({ ledger }: { ledger: DebtLedgerView }) {
  const t = useCopy();
  const locale = useCopyLocale();
  const w = ledger.window;
  const on = Boolean(w?.enabled);
  const next = on && w?.nextRunAt ? new Date(w.nextRunAt) : null;
  const tip = ledger.windowOff ?? (next ? t("activity.cleanup.nextRun", { at: next.toLocaleString(locale) }) : undefined);
  return (
    <span className="inline-flex items-center gap-1.5 text-12 font-normal normal-case tracking-normal text-muted" title={tip} data-testid="cleanup-window" data-on={on}>
      <i aria-hidden className={`inline-block size-2 flex-none rounded-full ${on ? "bg-ok-9" : "bg-neutral-8"}`} />
      {t(on ? "activity.cleanup.on" : "activity.cleanup.off")}
      {next ? <span className="font-mono text-11-5 text-subtle">{next.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span> : null}
    </span>
  );
}

export function CleanupPart({ projectId, now }: { projectId: string; now: number }) {
  const t = useCopy();
  const { ledger, reports } = useProjectCleanup(projectId, true);
  const label = t("activity.cleanup.title");
  const data = ledger.data;
  const last = reports.data?.reports[0] ?? null;
  const debts = new Map([...(data?.open ?? []), ...(data?.cleared ?? [])].map((d) => [d.id, d]));
  return (
    <section className="px-4.5 pt-4" aria-label={label} data-testid="activity-cleanup">
      <h3 className="flex items-baseline justify-between pb-1.5 text-11-5 font-semibold uppercase tracking-wide text-subtle">
        {label}
        {data ? <Window ledger={data} /> : null}
      </h3>
      {ledger.isError || reports.isError ? (
        <p className="py-1.5 text-13 text-subtle">{t("activity.cleanup.unread")}</p>
      ) : !data || !reports.data ? (
        <p className="py-1.5 text-13 text-subtle">…</p>
      ) : (
        <>
          {last ? (
            <Report report={last} debts={debts} now={now} />
          ) : (
            <p className="px-3 py-2 text-13 text-subtle" data-testid="cleanup-no-report">
              {t("activity.cleanup.noReport")}
            </p>
          )}
          {data.open.length > 0 ? (
            <Fold label={t("activity.cleanup.openDebt")} testId="cleanup-debts" trailing={<span className="font-mono text-12 tabular-nums text-muted">{data.open.length}</span>}>
              <DebtRows heading={false} label={t("activity.cleanup.openDebt")} rows={data.open.map((d) => ({ key: d.id, where: d.where, tip: d.detail }))} />
            </Fold>
          ) : null}
        </>
      )}
    </section>
  );
}
