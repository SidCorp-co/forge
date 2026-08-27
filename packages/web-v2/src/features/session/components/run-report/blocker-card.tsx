// The failure card. It sits above the fold because on a failed run it is the
// only thing the reader came for, and the transcript below is 400 rows deep.

import { Button, Icon } from "@/design";
import type { RunBlocker } from "../../run-report";

const MAX_LINES = 8;

export function BlockerCard({ blocker, onOpenIssue }: { blocker: RunBlocker; onOpenIssue?: () => void }) {
  const lines = blocker.output.split("\n").filter((l) => l.trim().length > 0);
  const shown = lines.slice(0, MAX_LINES);
  return (
    <section
      className="rounded-lg border px-5 py-4"
      style={{ borderColor: "var(--red-500)", background: "var(--red-50)" }}
      aria-labelledby="run-blocker-title"
    >
      <div className="flex items-start gap-2.5">
        <Icon name="alert" size={16} className="mt-0.5 flex-none" style={{ color: "var(--red-600)" }} />
        <div className="min-w-0 flex-1">
          <h2 id="run-blocker-title" className="fg-h3" style={{ color: "var(--red-600)" }}>
            {blocker.label}
          </h2>
          {blocker.errorCount > 1 && (
            <p className="fg-caption mt-0.5">
              {blocker.errorCount} calls failed in this run — this is the last one.
            </p>
          )}
          {shown.length > 0 && (
            <pre className="fg-mono mt-2.5 overflow-x-auto rounded-md bg-surface px-3 py-2 text-[11.5px] leading-[1.5]">
              {shown.join("\n")}
              {lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : ""}
            </pre>
          )}
        </div>
        {onOpenIssue && (
          <Button variant="secondary" size="sm" icon="list" className="flex-none" onClick={onOpenIssue}>
            Open issue
          </Button>
        )}
      </div>
    </section>
  );
}
