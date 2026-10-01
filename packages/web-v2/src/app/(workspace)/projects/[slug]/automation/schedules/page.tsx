"use client";

import { SchedulesScreen } from "@/features/schedules/components/schedules-screen";
import { ProjectGate } from "../project-gate";

export default function ProjectSchedulesPage() {
  return (
    <ProjectGate label="loading schedules…">
      {(p) => <SchedulesScreen scope={{ projectId: p.id, canManage: p.role === "admin" }} />}
    </ProjectGate>
  );
}
