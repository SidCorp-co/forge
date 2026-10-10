
import {
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  EmptyState,
  SegmentedControl,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatCount, formatMinutes, formatUsd } from "../format";
import type { AdminWorkspaceRow, OperatorWorkspaceSort } from "../types";

const SORTS: OperatorWorkspaceSort[] = ["runs", "spend", "leadTime"];

export function WorkspacesTableSkeleton() {
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.workspaces.title")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-2.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="text" className="h-4 w-full" />
        ))}
      </PageSectionBody>
    </PageSection>
  );
}

export function WorkspacesTable({
  rows,
  sort,
  onSortChange,
}: {
  rows: readonly AdminWorkspaceRow[];
  sort: OperatorWorkspaceSort;
  onSortChange: (sort: OperatorWorkspaceSort) => void;
}) {
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.workspaces.title")}</PageSectionTitle>
        <SegmentedControl options={SORTS.map((value) => ({ value, label: t(`operator.workspaces.sort.${value}`) }))} value={sort} onChange={onSortChange} />
      </PageSectionHeader>
      <PageSectionBody>
        {rows.length === 0 ? (
          <EmptyState message={t("operator.workspaces.empty")} mascot={false} />
        ) : (
          <Table className="min-w-130">
            <THead>
              <TR>
                <TH scope="col">{t("operator.workspaces.col.workspace")}</TH>
                <TH scope="col" className="text-right">{t("operator.workspaces.col.runs")}</TH>
                <TH scope="col" className="text-right">{t("operator.workspaces.col.spend")}</TH>
                <TH scope="col" className="text-right">{t("operator.workspaces.col.lead")}</TH>
                <TH scope="col" className="text-right">{t("operator.workspaces.col.open")}</TH>
              </TR>
            </THead>
            <TBody>
              {rows.slice(0, 10).map((r) => (
                <TR key={r.projectId}>
                  <TD className="font-mono">{r.slug}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatCount(r.runs)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatUsd(r.spendUsd)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatMinutes(r.medianLeadTimeMin)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatCount(r.openIssues)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
