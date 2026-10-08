"use client";

import type { BlockSource } from "@forge/contracts/visual-blocks";
import type { SourceFacts } from "./context";

function readAt(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * Where a block's figures came from: the run, its query and the moment it was read. A frame from an
 * execution is labelled computed. A block of a run whose query and read time are unknown never
 * reaches here: `VisualBlockView` refuses it by name.
 */
export function SourceNote({ source, facts }: { source: BlockSource | undefined; facts: SourceFacts | undefined }) {
  if (source === undefined) return null;
  if ("executionId" in source) {
    return (
      <p className="mt-1 font-mono text-[11px] text-subtle" data-testid="visual-block-source">
        Computed by execution {source.executionId}
      </p>
    );
  }
  return (
    <p className="mt-1 font-mono text-[11px] text-subtle" data-testid="visual-block-source">
      {`Report run ${source.runId}`}
      {facts && (
        <>
          {" · query "}
          <span data-testid="visual-block-query">{facts.queryId}</span>
          {" · read "}
          <time dateTime={facts.asOf}>{readAt(facts.asOf)}</time>
        </>
      )}
    </p>
  );
}
