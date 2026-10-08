"use client";

import type { BlockSource } from "@forge/contracts/visual-blocks";
import { useVisualBlockContext } from "./context";

function readAt(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * Where a block's figures came from: the query and the moment it was read. A frame from an
 * execution is labelled computed, and a block whose run this screen cannot read says so rather than
 * showing a source it does not know.
 */
export function SourceNote({ source }: { source: BlockSource | undefined }) {
  const { sourceFacts } = useVisualBlockContext();
  if (source === undefined) return null;
  const computed = "executionId" in source;
  const id = computed ? source.executionId : source.runId;
  const facts = sourceFacts?.(source);
  return (
    <p className="mt-1 font-mono text-[11px] text-subtle" data-testid="visual-block-source">
      {computed ? `Computed by execution ${id}` : `Report run ${id}`}
      {facts ? (
        <>
          {" · query "}
          <span data-testid="visual-block-query">{facts.queryId}</span>
          {" · read "}
          <time dateTime={facts.asOf}>{readAt(facts.asOf)}</time>
        </>
      ) : (
        " · query and read time are not loaded on this screen"
      )}
    </p>
  );
}
