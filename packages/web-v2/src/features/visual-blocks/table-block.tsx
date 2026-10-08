"use client";

import { type VisualBlockOf, tableRows } from "@forge/contracts/visual-blocks";
import { Cell } from "./cells";

const NUMERIC = new Set(["number", "duration"]);

/** A table block: the frame's chosen columns as a flush table on hairlines, sorted and cut as the block says. */
export function TableBlockView({ block }: { block: VisualBlockOf<"table"> }) {
  const fields = block.columns.flatMap((c) => block.frame.fields.filter((f) => f.name === c));
  const rows = tableRows(block);
  const hidden = block.frame.rows.length - rows.length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-line">
            {fields.map((f) => (
              <th
                key={f.name}
                scope="col"
                className={`py-1.5 pr-4 text-[11.5px] font-semibold text-subtle ${NUMERIC.has(f.type) ? "text-right" : ""}`}
              >
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // a frame row has no key of its own; the order is the block's and never changes under a reader
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={i} className="border-b border-line-subtle last:border-b-0">
              {fields.map((f) => (
                <td key={f.name} className={`py-1.5 pr-4 align-top ${NUMERIC.has(f.type) ? "text-right tabular-nums" : ""}`}>
                  <Cell field={f} cell={row[f.name]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="py-1.5 text-[12px] text-subtle">No rows.</p>}
      {hidden > 0 && (
        <p className="py-1 text-[11.5px] text-subtle">
          Showing {rows.length} of {block.frame.rows.length} rows.
        </p>
      )}
    </div>
  );
}
