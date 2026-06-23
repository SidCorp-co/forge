"use client";

// Merged project Automation surface (Concept C, ISS-307) — Schedules + PM under
// one tabbed shell. ISS-549 adds the 3rd "Improve" tab for the improvement-message
// catalog and run log. Active tab is mirrored to `?tab=` (shallow replaceState,
// hydrated on mount).
import { ScreenTabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { SchedulesScreen } from "@/features/schedules/components/schedules-screen";
import { ImproveScreen } from "@/features/improvement-messages/components/improve-screen";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { PmScreen } from "./pm-screen";

type AutomationTab = "schedules" | "pm" | "improve" | "feedback";

const TAB_VALUES = ["schedules", "pm", "improve", "feedback"] as const;
const TABS: TabItem[] = [
  { value: "schedules", label: "Schedules" },
  { value: "pm", label: "PM" },
  { value: "improve", label: "Improve" },
  { value: "feedback", label: "Feedback" },
];

export interface AutomationScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function AutomationScreen({ scope }: AutomationScreenProps) {
  const [tab, setTab] = useTabParam<AutomationTab>(TAB_VALUES, "schedules");

  return (
    <div className="flex min-h-full flex-col">
      <ScreenTabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AutomationTab)} />
      {tab === "schedules" && (
        <SchedulesScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "pm" && (
        <PmScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "improve" && (
        <ImproveScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "feedback" && (
        <FeedbackScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
    </div>
  );
}
