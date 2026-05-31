"use client";

// Merged project Automation surface (Concept C, ISS-307) — Schedules + PM under
// one tabbed shell. Both tabs render real, scoped screens: Schedules from the
// schedules feature, PM from this feature's PmScreen (cadence/config + decision
// audit log, ISS-315).
// Active tab is mirrored to `?tab=` (shallow replaceState, hydrated on mount).
import { Tabs, type TabItem } from "@/design";
import { useTabParam } from "@/lib/utils/use-tab-param";
import { SchedulesScreen } from "@/features/schedules/components/schedules-screen";
import { PmScreen } from "./pm-screen";

type AutomationTab = "schedules" | "pm";

const TAB_VALUES = ["schedules", "pm"] as const;
const TABS: TabItem[] = [
  { value: "schedules", label: "Schedules" },
  { value: "pm", label: "PM" },
];

export interface AutomationScreenProps {
  scope: { projectId: string; canManage: boolean };
}

export function AutomationScreen({ scope }: AutomationScreenProps) {
  const [tab, setTab] = useTabParam<AutomationTab>(TAB_VALUES, "schedules");

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-8 sm:pt-8">
        <Tabs tabs={TABS} value={tab} onChange={(v) => setTab(v as AutomationTab)} />
      </div>
      {tab === "schedules" && (
        <SchedulesScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
      {tab === "pm" && (
        <PmScreen scope={{ projectId: scope.projectId, canManage: scope.canManage }} />
      )}
    </div>
  );
}
