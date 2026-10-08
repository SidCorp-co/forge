"use client";

// REQ-33 BC-4, BC-5: a requirement's Memory tab, each memory naming its key, read through the one
// item memory section a workflow's and an issue's pages use.

import { ItemMemory, useItemMemoryCount } from "@/features/memory/components/item-memory";

export const useRequirementMemoryCount = (projectId: string, reqKey: string) => useItemMemoryCount(projectId, reqKey);

export function RequirementMemory({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  return <ItemMemory projectId={projectId} slug={slug} cites={reqKey} />;
}
