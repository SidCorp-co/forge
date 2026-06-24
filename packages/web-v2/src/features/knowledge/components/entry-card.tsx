"use client";

// Shared entry card: renders a knowledge entry (title + confidence badge + body via
// KnowledgeMarkdown). Inferred entries get a Confirm button (PUT confidence:verified).
// Manages its own open state so the full body is fetched lazily on expand.
import { useState } from "react";
import { Badge, Button, Icon, Skeleton } from "@/design";
import { KnowledgeMarkdown } from "@/design";
import { useKnowledgeEntry, useUpsertEntry } from "../hooks";
import type { KnowledgeListRow } from "../types";

const CONFIDENCE_TONE: Record<string, "green" | "amber" | "neutral"> = {
  verified: "green",
  inferred: "amber",
  deprecated: "neutral",
};

interface EntryCardProps {
  projectId: string;
  row: KnowledgeListRow;
  canManage: boolean;
  defaultOpen?: boolean;
}

export function EntryCard({ projectId, row, canManage, defaultOpen = false }: EntryCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Full body fetched lazily once open
  const entryQ = useKnowledgeEntry(open ? projectId : undefined, open ? row.slug : undefined);
  const upsert = useUpsertEntry(projectId);

  function handleConfirm() {
    if (!entryQ.data) return;
    const { title, body, kind, injection, authoredBy, orderIndex, metadata } = entryQ.data;
    upsert.mutate({
      slug: row.slug,
      body: {
        title,
        body,
        kind: kind as never,
        injection: injection as never,
        confidence: "verified",
        authoredBy: authoredBy as never,
        orderIndex,
        metadata: metadata as Record<string, unknown>,
      },
    });
  }

  const tone: "green" | "amber" | "neutral" = CONFIDENCE_TONE[row.confidence] ?? "neutral";

  return (
    <div className="rounded-md border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-4 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Icon
          name="chevronRight"
          size={16}
          className="shrink-0 text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <span className="fg-label min-w-0 flex-1 truncate">{row.title}</span>
        <Badge tone={tone}>
          {row.confidence}
        </Badge>
      </button>

      {open && (
        <div className="border-t border-line px-4 pb-4 pt-3">
          {entryQ.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-5/6 rounded" />
            </div>
          )}
          {entryQ.isError && (
            <p className="fg-caption text-red-600">Failed to load entry body.</p>
          )}
          {entryQ.data && (
            <>
              <KnowledgeMarkdown>{entryQ.data.body}</KnowledgeMarkdown>
              {canManage && row.confidence === "inferred" && (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={upsert.isPending}
                    onClick={handleConfirm}
                  >
                    Confirm (mark verified)
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
