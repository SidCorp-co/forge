// What one run was given (REQ-90 BC-7, BC-9): each agreement revision recorded as reaching the run,
// from which lane it came, and whether that is still the rule in force, apart from the current rules.
// The agreements it was not given wait in a group of their own.

import type { AgreementView } from "@forge/contracts/agreements";
import { type ListGroup, TBody, TD, TH, THead, TR, Table, StatusChip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import type { ReceivedRow } from "../view";
import { AgreementName, type Fold, GroupInTable } from "./agreement-lanes";

const NOW_TONE = { same: "neutral", changed: "you", retired: "done" } as const;

function Received({ r, selected, onOpen, t }: { r: ReceivedRow; selected: boolean; onOpen: (slug: string) => void; t: Copy }) {
  return (
    <TR data-testid="agreement-row" data-name={r.agreement.name} aria-selected={selected || undefined} className={cn(selected && "bg-sel")}>
      <TD className="pl-8">
        <AgreementName a={r.agreement} onOpen={onOpen} t={t} />
      </TD>
      <TD data-testid="run-received">{t(`agreements.layer.${r.layer}` as ProductCopyKey)}</TD>
      <TD>
        <span data-testid="run-now">
          <StatusChip tone={NOW_TONE[r.now]} label={t(`agreements.now.${r.now}` as ProductCopyKey)} value={r.now} />
        </span>
      </TD>
    </TR>
  );
}

function NotReceived({ a, selected, onOpen, t }: { a: AgreementView; selected: boolean; onOpen: (slug: string) => void; t: Copy }) {
  return (
    <TR data-testid="agreement-missing" data-name={a.name} className={cn(selected && "bg-sel")}>
      <TD className="pl-8" colSpan={3}>
        <AgreementName a={a} onOpen={onOpen} t={t} />
      </TD>
    </TR>
  );
}

export function RunReceived({ received, missing, fold, selected, onOpen }: { received: ReceivedRow[]; missing: AgreementView[]; fold: Fold; selected: string | null; onOpen: (slug: string) => void }) {
  const t = useCopy();
  const got: ListGroup<ReceivedRow> = { id: "received", label: t("agreements.group.received"), tone: "run", rows: received };
  const not: ListGroup<AgreementView> = { id: "not-received", label: t("agreements.group.notReceived"), tone: "neutral", rows: missing, collapsed: true };
  return (
    <Table aria-label={t("agreements.col.received")} className="table-fixed">
      <THead>
        <TR>
          <TH className="pl-8">{t("agreements.col.agreement")}</TH>
          <TH className="w-48">{t("agreements.col.received")}</TH>
          <TH className="w-32">{t("agreements.col.now")}</TH>
        </TR>
      </THead>
      <TBody>
        <GroupInTable g={got} fold={fold} span={3} />
        {fold.isOpen(got.id, got.collapsed) ? received.map((r) => <Received key={r.agreement.slug} r={r} selected={selected === r.agreement.slug} onOpen={onOpen} t={t} />) : null}
        {missing.length > 0 ? <GroupInTable g={not} fold={fold} span={3} /> : null}
        {fold.isOpen(not.id, not.collapsed) ? missing.map((a) => <NotReceived key={a.slug} a={a} selected={selected === a.slug} onOpen={onOpen} t={t} />) : null}
      </TBody>
    </Table>
  );
}
