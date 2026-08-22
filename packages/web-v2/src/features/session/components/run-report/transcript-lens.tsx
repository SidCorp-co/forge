"use client";

// The Transcript lens — every tool call, one row each, newest last.
//
// Rows are `ts · tool · arg · outcome`, not a JSON dump: the outcome column is
// what makes 400 rows scannable, and it is derived per tool kind (a Read says
// "218 lines", a test run says "428 passed, 1 failed"). `e` / `c` expand and
// collapse everything, which is how a reader diffs two runs quickly.
import { useEffect, useState } from "react";
import { Kbd } from "@/design";
import type { TranscriptRow } from "../../run-report";

const TONE_COLOR = {
  ok: "var(--green-600)",
  bad: "var(--red-600)",
  muted: "var(--fg-subtle)",
} as const;

const MAX_BODY_CHARS = 1200;

function clockOf(ts: number | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Row({ row, open, onToggle }: { row: TranscriptRow; open: boolean; onToggle: () => void }) {
  const body = row.body.length > MAX_BODY_CHARS ? `${row.body.slice(0, MAX_BODY_CHARS)}\n…` : row.body;
  return (
    <li
      className="border-line-subtle border-b last:border-b-0"
      style={row.isError ? { background: "var(--red-50)" } : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2.5 px-3 py-1.5 text-left hover:bg-hover"
      >
        <span className="fg-caption w-[62px] flex-none font-mono">{clockOf(row.timestamp)}</span>
        <span
          className="fg-caption w-[92px] flex-none truncate font-mono"
          style={row.isMcp ? { color: "var(--cobalt-500)" } : undefined}
        >
          {row.tool}
        </span>
        <span className="fg-body-sm min-w-0 flex-1 truncate font-mono">{row.arg}</span>
        <span
          className="fg-caption max-w-[42%] flex-none truncate font-mono"
          style={{ color: TONE_COLOR[row.outcome.tone] }}
        >
          {row.outcome.text}
        </span>
      </button>
      {open && body && (
        <pre className="fg-mono mx-3 mb-2 overflow-x-auto rounded-md bg-sunken px-3 py-2 text-[11.5px] leading-[1.5]">
          {body}
        </pre>
      )}
    </li>
  );
}

export function TranscriptLens({ rows }: { rows: TranscriptRow[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === "e") setOpenIds(new Set(rows.map((r) => r.id)));
      if (e.key === "c") setOpenIds(new Set());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows]);

  return (
    <div>
      <div className="border-line-subtle flex items-center gap-2 border-b px-3 py-2">
        <span className="fg-caption flex-1">{rows.length} tool calls, newest last</span>
        <span className="fg-caption">
          expand all <Kbd>e</Kbd> · collapse <Kbd>c</Kbd>
        </span>
      </div>
      <ul>
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            open={openIds.has(row.id)}
            onToggle={() =>
              setOpenIds((prev) => {
                const next = new Set(prev);
                if (!next.delete(row.id)) next.add(row.id);
                return next;
              })
            }
          />
        ))}
      </ul>
    </div>
  );
}
