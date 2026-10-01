"use client";

import { Badge } from "@/design";
import { cn } from "@/lib/utils/cn";
import { dayOf } from "../format";
import { statusLabel } from "../version-status";
import type { ReleaseDraft, ReleaseVersionRow } from "../versions-types";

const STAGE_TONE: Record<string, string> = {
  ok: "var(--green-600, #23794a)",
  failed: "var(--red-600, #b3402b)",
  unverified: "var(--amber-500, #c48a00)",
};

function Stages({ v }: { v: ReleaseVersionRow }) {
  const all = ["promote", "deploy", "verify"] as const;
  return (
    <span className="flex gap-1" title="promote · deploy · verify">
      {all.map((stage) => {
        const s = v.stages.find((x) => x.stage === stage);
        const bg = !s ? "var(--bg-sunken)" : !s.settled ? "var(--amber-500, #c48a00)" : (STAGE_TONE[s.verdict ?? ""] ?? "var(--border-strong)");
        return <i key={stage} title={`${stage}: ${s ? (s.settled ? (s.verdict ?? "settled") : "running") : "not opened"}`} className="h-1.5 w-5 rounded-sm" style={{ background: bg }} />;
      })}
    </span>
  );
}

export interface VersionListProps {
  versions: ReleaseVersionRow[];
  draft: ReleaseDraft | null;
  selected: string | null;
  onSelect: (version: string) => void;
}

export function VersionList({ versions, draft, selected, onSelect }: VersionListProps) {
  return (
    <div className="overflow-auto border-line-subtle md:border-r" data-testid="version-list">
      {draft ? (
        <button
          type="button"
          onClick={() => onSelect(draft.version)}
          className={cn(
            "grid w-full grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line-subtle px-4 py-3 text-left text-13 hover:bg-hover sm:px-7",
            selected === draft.version && "bg-accent-tint",
          )}
          data-testid="version-row-draft"
        >
          <span className="font-mono text-13 font-semibold">{draft.version}</span>
          <span className="text-12 text-subtle">draft · {draft.issues.length} issues</span>
          <Badge>draft</Badge>
        </button>
      ) : null}
      {versions.map((v) => {
        const s = statusLabel(v);
        return (
          <button
            key={v.runId}
            type="button"
            onClick={() => onSelect(v.version)}
            className={cn(
              "grid w-full grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 border-b border-line-subtle px-4 py-3 text-left text-13 hover:bg-hover sm:px-7",
              selected === v.version && "bg-accent-tint",
            )}
            data-testid="version-row"
            data-status={v.status}
          >
            <span className="font-mono text-13 font-semibold">{v.version}</span>
            <span className="text-12 text-subtle">
              {dayOf(v.releasedAt ?? v.openedAt)} · {v.issueCount} issues
            </span>
            <Stages v={v} />
            <span className="col-start-2 justify-self-start">
              <Badge tone={s.tone}>{s.label}</Badge>
            </span>
          </button>
        );
      })}
    </div>
  );
}
