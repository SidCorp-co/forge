"use client";

// Automation (`/projects/[slug]/automation`): the project's schedules and its improvement messages,
// as two tabs of one page under Development (ISS-65). The tab rides `?tab=` and its switch sits in the
// top header beside the title; the old `/automation/schedules` and `/automation/improvements`
// addresses redirect here.

import { PageTitle, SegmentedControl, useUrlTab } from "@/design";
import { ImprovementsScreen } from "@/features/improvement-messages/components/improvements-screen";
import { canWriteProject } from "@/features/projects/write-access";
import { SchedulesScreen } from "@/features/schedules/components/schedules-screen";
import { ProjectGate } from "./project-gate";

const TABS = ["schedules", "improvements"] as const;

export default function ProjectAutomationPage() {
  const [tab, setTab] = useUrlTab(TABS);
  const header = (
    <PageTitle
      hint="Recurring runs for this project, and what agents report about the harness with the improvement loop's proposals."
      after={
        <span className="ml-2 inline-flex" data-testid="automation-tabs">
          <SegmentedControl
            options={[
              { value: "schedules", label: "Schedules" },
              { value: "improvements", label: "Improvements" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </span>
      }
    >
      Automation
    </PageTitle>
  );
  return (
    <ProjectGate label="loading automation…">
      {(p) =>
        tab === "schedules" ? (
          <SchedulesScreen header={header} scope={{ projectId: p.id, canManage: p.role === "admin" }} />
        ) : (
          <ImprovementsScreen
            header={header}
            scope={{ projectId: p.id, slug: p.slug, canManage: p.role === "admin", canWrite: canWriteProject(p.role) }}
          />
        )
      }
    </ProjectGate>
  );
}
