"use client";

import { MemoryScreen } from "@/features/memory/components/memory-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

// The memory read addresses a project by its uuid only, so the page waits for the list to name it.
export default function ProjectMemoryPage() {
  const t = useCopy();
  return <ProjectGate label={t("memory.loading")}>{(p) => <MemoryScreen projectId={p.id} slug={p.slug} />}</ProjectGate>;
}
