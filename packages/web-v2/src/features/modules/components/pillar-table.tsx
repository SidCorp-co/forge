// The pillar (ISS-1256): one row per business module, one column per branch of its tree, each count
// opening that module's tree at that branch; open issues are the only health figure, with no score.
// The Unplaced row counts what no module holds. A gap (a module with no term or rule, anything
// unplaced) is drawn in the warning tone and gates nothing.

import { Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { cn } from "@/lib/utils/cn";
import { type PillarCell, type PillarRowView, TREE_BRANCHES, type TreeBranch } from "../pillar";

export const branchLabel = (t: Copy, b: TreeBranch) => t(`modules.type.${b}` as ProductCopyKey);

function Count({ cell, module }: { cell: PillarCell; module: string }) {
  const t = useCopy();
  const label = cell.branch === "inflight" ? t("modules.col.open") : branchLabel(t, cell.branch);
  return (
    <TD className="text-right tabular-nums">
      <Link
        href={cell.href}
        aria-label={t("modules.count.label", { module, n: cell.count, branch: label })}
        title={cell.gap && cell.count === 0 ? t("modules.gap") : undefined}
        className={cn("inline-block min-w-6 rounded-sm px-1 hover:bg-hover hover:underline", cell.gap ? "font-semibold text-warn-11" : cell.count === 0 ? "text-disabled" : "text-fg")}
        data-testid="pillar-count"
        data-branch={cell.branch}
        data-gap={cell.gap || undefined}
      >
        {cell.count}
      </Link>
    </TD>
  );
}

function ModuleCell({ row }: { row: PillarRowView }) {
  const t = useCopy();
  const name = row.unplaced ? t("modules.unplaced") : row.name;
  return (
    <TD className={cn("sticky left-0 z-1 max-w-72 max-md:max-w-36", row.unplaced ? "bg-sunken" : "bg-surface")}>
      <Link href={row.href} className={cn("font-semibold hover:underline", row.unplaced ? "text-warn-11" : "text-fg")}>
        {name}
      </Link>
      {row.unplaced ? null : row.description ? (
        <span className="block truncate text-12 text-muted" title={row.description}>
          {row.description}
        </span>
      ) : (
        <span className="block text-12 text-warn-11">{t("modules.noPurpose")}</span>
      )}
    </TD>
  );
}

export function PillarTable({ rows }: { rows: readonly PillarRowView[] }) {
  const t = useCopy();
  return (
    <Table aria-label={t("modules.title")} className="min-w-200" data-testid="pillar">
      <THead>
        <TR>
          <TH className="sticky left-0 z-1 bg-surface">{t("modules.col.module")}</TH>
          {TREE_BRANCHES.map((b) => (
            <TH key={b} className="text-right">
              {b === "inflight" ? t("modules.col.open") : branchLabel(t, b)}
            </TH>
          ))}
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.key} data-testid={row.unplaced ? "pillar-unplaced" : "pillar-row"} className={row.unplaced ? "bg-sunken" : undefined}>
            <ModuleCell row={row} />
            {row.cells.map((c) => (
              <Count key={c.branch} cell={c} module={row.unplaced ? t("modules.unplaced") : row.name} />
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
