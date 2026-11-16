// The pillar (ISS-1256): one row per business module, one column per branch of its tree, each count
// opening that module's tree at that branch; open issues are the only health figure, with no score.
// The Unplaced row counts what no module holds. A gap (a module with no term or rule, anything
// unplaced) is drawn in the warning tone and gates nothing. On a phone the rows stack, each module a
// block with its counts in a grid, so every branch reads without a sideways scroll.

import { Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { cn } from "@/lib/utils/cn";
import { type PillarCell, type PillarRowView, TREE_BRANCHES, type TreeBranch } from "../pillar";

export const branchLabel = (t: Copy, b: TreeBranch) => t(`modules.type.${b}` as ProductCopyKey);

function CountLink({ cell, module }: { cell: PillarCell; module: string }) {
  const t = useCopy();
  const label = cell.branch === "inflight" ? t("modules.col.open") : branchLabel(t, cell.branch);
  return (
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
  );
}

function ModuleName({ row }: { row: PillarRowView }) {
  const t = useCopy();
  const name = row.unplaced ? t("modules.unplaced") : row.name;
  return (
    <>
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
    </>
  );
}

const branchHead = (t: Copy, b: TreeBranch) => (b === "inflight" ? t("modules.col.open") : branchLabel(t, b));

/** A phone's pillar: each module a block, its name over a grid of its counts, each labelled. */
function PillarStack({ rows }: { rows: readonly PillarRowView[] }) {
  const t = useCopy();
  return (
    <ul aria-label={t("modules.title")} className="grid gap-2 md:hidden" data-testid="pillar-stack">
      {rows.map((row) => (
        <li
          key={row.key}
          className={cn("min-w-0 rounded-md border border-line-subtle px-3 py-2.5", row.unplaced ? "bg-sunken" : "bg-surface")}
          data-testid={row.unplaced ? "pillar-stack-unplaced" : "pillar-stack-row"}
        >
          <ModuleName row={row} />
          <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5">
            {row.cells.map((c) => (
              <div key={c.branch} className="min-w-0">
                <dt className="truncate text-11 text-muted">{branchHead(t, c.branch)}</dt>
                <dd className="tabular-nums">
                  <CountLink cell={c} module={row.unplaced ? t("modules.unplaced") : row.name} />
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function PillarTable({ rows }: { rows: readonly PillarRowView[] }) {
  const t = useCopy();
  return (
    <>
      <div className="max-md:hidden">
        <Table aria-label={t("modules.title")} className="min-w-200" data-testid="pillar">
          <THead>
            <TR>
              <TH className="sticky left-0 z-1 bg-surface">{t("modules.col.module")}</TH>
              {TREE_BRANCHES.map((b) => (
                <TH key={b} className="text-right">
                  {branchHead(t, b)}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.key} data-testid={row.unplaced ? "pillar-unplaced" : "pillar-row"} className={row.unplaced ? "bg-sunken" : undefined}>
                <TD className={cn("sticky left-0 z-1 max-w-72", row.unplaced ? "bg-sunken" : "bg-surface")}>
                  <ModuleName row={row} />
                </TD>
                {row.cells.map((c) => (
                  <TD key={c.branch} className="text-right tabular-nums">
                    <CountLink cell={c} module={row.unplaced ? t("modules.unplaced") : row.name} />
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <PillarStack rows={rows} />
    </>
  );
}
