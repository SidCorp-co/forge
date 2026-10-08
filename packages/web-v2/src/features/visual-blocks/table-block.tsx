"use client";

import type { ReportField } from "@forge/contracts/report-queries";
import { cellText, type VisualBlockOf, tableRows } from "@forge/contracts/visual-blocks";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Cell } from "./cells";

const NUMERIC = new Set(["number", "duration"]);

/** The rows a table shows before it is asked for the rest: a chat answer stays one screen tall. */
export const TABLE_ROW_CAP = 10;

/**
 * How a column's cells hold their width in a narrow container. A text column never squeezes below a
 * readable measure: it keeps a minimum width, wraps to two lines at most, and carries its full text
 * on hover. A figure, a date, a key or a state never wraps, and a figure is right-aligned in
 * tabular digits so a column of them reads down.
 */
function cellClass(f: ReportField): string {
  if (NUMERIC.has(f.type)) return "whitespace-nowrap text-right tabular-nums";
  if (f.type === "string") return "";
  return "whitespace-nowrap";
}

/**
 * A text cell: a readable minimum width, two lines at most, the whole text on hover, and a tap or a
 * key that opens it in place, so a reader without a pointer still reaches its last sentence.
 */
function ClampedText({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        "block min-w-[10rem] max-w-[20rem] cursor-text text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        !open && "line-clamp-2",
      )}
      title={text}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      data-testid="table-text"
    >
      {children}
    </button>
  );
}

/** The first column stays put while the rest scroll sideways, on the page's own ground so nothing shows through it. */
const STICKY = "sticky left-0 z-[1] bg-app";

/**
 * A table block: the frame's chosen columns as a flush table on hairlines, sorted and cut as the
 * block says. It scrolls sideways inside its container rather than squeeze its text, and shows its
 * first rows with a control for the rest.
 */
export function TableBlockView({ block }: { block: VisualBlockOf<"table"> }) {
  const [all, setAll] = useState(false);
  const fields = block.columns.flatMap((c) => block.frame.fields.filter((f) => f.name === c));
  const rows = tableRows(block);
  const shown = all ? rows : rows.slice(0, TABLE_ROW_CAP);
  const hidden = block.frame.rows.length - rows.length;
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto" data-testid="table-scroll">
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-line">
              {fields.map((f, c) => (
                <th
                  key={f.name}
                  scope="col"
                  className={cn(
                    "py-1.5 pr-4 align-bottom text-[11.5px] font-semibold text-subtle",
                    NUMERIC.has(f.type) && "text-right",
                    c === 0 && STICKY,
                  )}
                  data-type={f.type}
                >
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              // a frame row has no key of its own; the order is the block's and never changes under a reader
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <tr key={i} className="border-b border-line-subtle last:border-b-0">
                {fields.map((f, c) => (
                  <td key={f.name} className={cn("py-1.5 pr-4 align-top", cellClass(f), c === 0 && STICKY)} data-type={f.type}>
                    {f.type === "string" ? (
                      <ClampedText text={cellText(f, row[f.name])}>
                        <Cell field={f} cell={row[f.name]} />
                      </ClampedText>
                    ) : (
                      <Cell field={f} cell={row[f.name]} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="py-1.5 text-[12px] text-subtle">No rows.</p>}
      {rows.length > TABLE_ROW_CAP && (
        <button
          type="button"
          className="mt-1 text-[12px] font-medium text-link hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
          data-testid="table-show-all"
        >
          {all ? `Show the first ${TABLE_ROW_CAP} rows` : `Show all ${rows.length} rows`}
        </button>
      )}
      {hidden > 0 && (
        <p className="py-1 text-[11.5px] text-subtle">
          Showing {rows.length} of {block.frame.rows.length} rows.
        </p>
      )}
    </div>
  );
}
