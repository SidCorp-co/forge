"use client";

// Merged project Library surface (Concept C, ISS-307) — Knowledge + Skills +
// Updates under one tabbed shell. Each tab renders its existing scoped screen
// unchanged (those screens bring their own page chrome / header), so this shell
// only adds the tab strip. Active tab is mirrored to `?tab=` (shallow
// replaceState, hydrated from the URL on mount) so deep-links work.
import { ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { KnowledgeScreen } from "@/features/knowledge/components/knowledge-screen";
import { SkillsScreen } from "@/features/skills/components/skills-screen";
import { SkillUpdatesScreen } from "@/features/skill-updates/components/skill-updates-screen";

type LibraryTab = "knowledge" | "skills" | "updates";

const TAB_VALUES = ["knowledge", "skills", "updates"] as const;
const TABS: TabItem[] = [
  { value: "knowledge", label: "Knowledge" },
  { value: "skills", label: "Skills" },
  { value: "updates", label: "Updates" },
];

export interface LibraryScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function LibraryScreen({ scope }: LibraryScreenProps) {
  const [tab, setTab] = useTabParam<LibraryTab>(TAB_VALUES, "knowledge");

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTabs tabs={TABS} value={tab} onChange={(v) => setTab(v as LibraryTab)} />
      {tab === "knowledge" && (
        <KnowledgeScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "skills" && (
        <SkillsScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "updates" && (
        <SkillUpdatesScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
    </div>
  );
}
