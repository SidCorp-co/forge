"use client";

// REQ-33 BC-2, BC-4: an issue's Decisions and Memory tabs, the decisions recorded on it and the
// memories naming it, read on the issue itself through the one entity decisions read and the one
// item memory section a requirement's and a workflow's pages use.

import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { ItemMemory } from "@/features/memory/components/item-memory";

export function IssueDecisionsTab({ projectId, issueKey }: { projectId: string; issueKey: string }) {
  return <DecisionsPanel projectId={projectId} scope="issue" targetRef={issueKey} />;
}

export function IssueMemoryTab({ projectId, slug, issueKey }: { projectId: string; slug: string; issueKey: string }) {
  return <ItemMemory projectId={projectId} slug={slug} cites={issueKey} />;
}
