"use client";

// Merged project Library surface (Concept C, ISS-307) — Knowledge + Memory +
// Skills under one tabbed shell. Each tab renders its existing scoped screen
// unchanged (those screens bring their own page chrome / header), so this shell
// only adds the tab strip. Active tab is mirrored to `?tab=` (shallow
// replaceState, hydrated from the URL on mount) so deep-links work.
import { Tabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { KnowledgeScreen } from "@/features/knowledge/components/knowledge-screen";
import { MemoryScreen } from "@/features/memory/components/memory-screen";
import { SkillsScreen } from "@/features/skills/components/skills-screen";

type LibraryTab = "knowledge" | "memory" | "skills";

const TAB_VALUES = ["knowledge", "memory", "skills"] as const;
const TABS: TabItem[] = [
  { value: "knowledge", label: "Knowledge" },
  { value: "memory", label: "Memory" },
  { value: "skills", label: "Skills" },
];

export interface LibraryScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function LibraryScreen({ scope }: LibraryScreenProps) {
  const [tab, setTab] = useTabParam<LibraryTab>(TAB_VALUES, "knowledge");

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-8 sm:pt-8">
        <Tabs tabs={TABS} value={tab} onChange={(v) => setTab(v as LibraryTab)} />
      </div>
      {tab === "knowledge" && (
        <KnowledgeScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "memory" && <MemoryScreen scope={{ projectId: scope.projectId }} />}
      {tab === "skills" && (
        <SkillsScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
    </div>
  );
}
