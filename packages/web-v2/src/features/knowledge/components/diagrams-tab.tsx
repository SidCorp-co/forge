"use client";

import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  MermaidDiagram,
  SegmentedControl,
  type SegmentOption,
  Skeleton,
} from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useModuleDiagram } from "../hooks";
import type { ModuleDiagramKind } from "../types";

const KINDS: SegmentOption<ModuleDiagramKind>[] = [
  { value: "mindmap", label: "Mindmap" },
  { value: "context", label: "Context" },
  { value: "user-flow", label: "User flow" },
  { value: "swimlane", label: "Swimlane" },
];

const WHAT_IT_READS: Record<ModuleDiagramKind, string> = {
  mindmap: "The module hierarchy, with what each module’s knowledge node relates to.",
  context: "Modules as nodes — dotted edges are issues they share, solid edges are declared.",
  "user-flow": "The flow each module stores in its knowledge node.",
  swimlane: "The same steps, in lanes taken from each node’s actor.",
};

// cm:guard a refusal is an EmptyState and a failure is an ErrorState, and they must not merge — `NO_MODULES` tells the reader to go and create a module, while a 500 tells them to retry, and a single "couldn't load" box gives whichever reader is wrong no way to find that out.
const REFUSALS = new Set(["NO_MODULES", "NO_MODULE_FLOWS", "UNPARSABLE_MODULE_FLOW"]);

interface DiagramsTabProps {
  projectId: string;
}

/**
 * ISS-950 — the four generated kinds, read one at a time.
 *
 * Nothing here is stored or cached: what the tab shows is what the modules and their knowledge
 * nodes say at the moment of the request.
 */
export function DiagramsTab({ projectId }: DiagramsTabProps) {
  const [kind, setKind] = useState<ModuleDiagramKind>("mindmap");
  const q = useModuleDiagram(projectId, kind);
  const refusal = q.error instanceof ApiError && q.error.code && REFUSALS.has(q.error.code);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl options={KINDS} value={kind} onChange={setKind} />
        <p className="fg-body-sm text-muted">{WHAT_IT_READS[kind]}</p>
      </div>

      {q.isLoading && <Skeleton className="h-64 w-full rounded-lg" />}

      {q.isError && refusal && (
        <EmptyState title="Nothing to draw yet" message={formatApiError(q.error)} />
      )}

      {q.isError && !refusal && (
        <ErrorState
          title="Couldn’t load the diagram"
          message={formatApiError(q.error)}
          onRetry={() => q.refetch()}
        />
      )}

      {q.data && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <MermaidDiagram code={q.data.mermaid} />
          <p className="fg-caption mt-3 text-muted">
            Generated from {q.data.moduleCount} module{q.data.moduleCount === 1 ? "" : "s"} on this
            read — never from a stored copy.
          </p>
        </div>
      )}
    </div>
  );
}
