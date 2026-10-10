"use client";

import { keyedByContent } from "@/design";
import { cellText, type VisualBlockOf } from "@forge/contracts/visual-blocks";
import { Cell } from "./cells";
import { useBlockInstants } from "./instants";

/** A status-list block: one hairline row per frame row, its ref a link to the issue, requirement or release it names. */
export function StatusListBlockView({ block }: { block: VisualBlockOf<"status-list"> }) {
  const instants = useBlockInstants();
  const field = (name: string) => block.frame.fields.find((f) => f.name === name);
  const ref = field(block.ref);
  const status = field(block.status);
  const waiting = block.waitingOn === undefined ? undefined : field(block.waitingOn);
  if (!ref || !status) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {keyedByContent(block.frame.rows).map(({ key, item: row }) => {
        const on = waiting ? row[waiting.name] : null;
        return (
          <li key={key} className="flex min-w-0 flex-wrap items-center gap-x-3 border-b border-line-subtle py-1.5 text-13 last:border-b-0" data-testid="status-row">
            <span className="min-w-21">
              <Cell field={ref} cell={row[ref.name]} />
            </span>
            <span className="min-w-0">
              <Cell field={status} cell={row[status.name]} />
            </span>
            {waiting && on !== null && on !== undefined && (
              <span className="text-12 text-subtle">waiting on {cellText(waiting, on, instants)}</span>
            )}
          </li>
        );
      })}
      {block.frame.rows.length === 0 && <li className="py-1.5 text-12 text-subtle">No items.</li>}
    </ul>
  );
}
