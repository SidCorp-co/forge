"use client";

import { Badge } from "@/design";
import { cn } from "@/lib/utils/cn";
import { dayOf } from "../format";
import { statusLabel } from "../version-status";
import type { ReleaseFlow } from "../flow";
import type { ReleaseDraft, ReleaseVersionRow } from "../versions-types";
import { StageTracker } from "./flow-strip";

export interface VersionListProps {
  versions: ReleaseVersionRow[];
  draft: ReleaseDraft | null;
  flow: ReleaseFlow;
  selected: string | null;
  onSelect: (version: string) => void;
}

export function VersionList({ versions, draft, flow, selected, onSelect }: VersionListProps) {
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
          <Badge>Draft</Badge>
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
            <StageTracker v={v} flow={flow} />
            <span className="col-start-2 justify-self-start">
              <Badge tone={s.tone}>{s.label}</Badge>
            </span>
          </button>
        );
      })}
    </div>
  );
}
