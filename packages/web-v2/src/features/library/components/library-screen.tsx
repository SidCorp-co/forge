"use client";

// Library: Knowledge, Skills and Updates as one row of peer tabs, mirrored to `?tab=` so
// deep-links work. Each tab brings its own page chrome.
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
