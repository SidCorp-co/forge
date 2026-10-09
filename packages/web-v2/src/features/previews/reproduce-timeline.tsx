"use client";

// A recording's timeline as a flat table (REQ-41 BC-18, BC-19): when, what kind of thing, and what
// it was, in the words `@forge/contracts/reproduce:timelineOf` wrote. The feedback page draws it
// whole; a chat turn draws its first lines.

import type { TimelineEntry } from "@forge/contracts/reproduce";
import { useCopy } from "@/lib/i18n/interface-language";

type Copy = ReturnType<typeof useCopy>;

/** `m:ss.s` from the recording's start. */
export function atOf(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

const KIND_KEYS: Record<TimelineEntry["kind"], Parameters<Copy>[0]> = {
  navigate: "previews.recordings.kind.navigate",
  viewport: "previews.recordings.kind.viewport",
  click: "previews.recordings.kind.click",
  input: "previews.recordings.kind.input",
  console_error: "previews.recordings.kind.console_error",
  console_warn: "previews.recordings.kind.console_warn",
  request_failed: "previews.recordings.kind.request_failed",
};

const BAD: ReadonlySet<TimelineEntry["kind"]> = new Set(["console_error", "request_failed"]);

/** Each entry with a key of its own: the same line twice at the same moment is drawn twice, as recorded. */
function keyed(entries: readonly TimelineEntry[]): { key: string; entry: TimelineEntry }[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = `${entry.at}:${entry.kind}:${entry.text}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: `${base}:${n}`, entry };
  });
}

export function TimelineTable({ entries, compact = false, testId = "recording-timeline" }: { entries: readonly TimelineEntry[]; compact?: boolean; testId?: string }) {
  const t = useCopy();
  return (
    <table className={`w-full border-collapse ${compact ? "text-12-5" : "text-13"}`} data-testid={testId}>
      <tbody>
        {keyed(entries).map(({ key, entry: e }) => (
          <tr key={key} className="border-b border-line-subtle align-top" data-kind={e.kind}>
            <td className="w-16 py-1 pr-3 font-mono text-muted">{atOf(e.at)}</td>
            {compact ? null : <td className={`w-36 py-1 pr-3 ${BAD.has(e.kind) ? "font-medium text-danger" : "text-muted"}`}>{t(KIND_KEYS[e.kind])}</td>}
            <td className={`break-words py-1 ${compact && BAD.has(e.kind) ? "text-danger" : ""}`}>{e.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
