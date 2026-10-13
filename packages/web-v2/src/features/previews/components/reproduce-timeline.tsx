
// A recording's timeline as a flat table (REQ-41 BC-18, BC-19): when, what kind of thing, and what
// it was, in the words `@forge/contracts/reproduce:timelineOf` wrote. The feedback page draws it
// whole; a chat turn draws its first lines.

import type { TimelineEntry } from "@forge/contracts/reproduce";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

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

export function Timeline({ entries, compact = false, testId = "recording-timeline" }: { entries: readonly TimelineEntry[]; compact?: boolean; testId?: string }) {
  const t = useCopy();
  return (
    <ol className="w-full text-13" data-testid={testId}>
      {keyed(entries).map(({ key, entry: e }) => (
        <li key={key} className="flex items-start gap-3 border-b border-line-subtle py-1" data-kind={e.kind}>
          <span className="w-16 flex-none font-mono text-muted">{atOf(e.at)}</span>
          {compact ? null : <span className={cn("w-36 flex-none", BAD.has(e.kind) ? "font-medium text-danger" : "text-muted")}>{t(KIND_KEYS[e.kind])}</span>}
          <span className={cn("min-w-0 flex-1 break-words", compact && BAD.has(e.kind) && "text-danger")}>{e.text}</span>
        </li>
      ))}
    </ol>
  );
}
