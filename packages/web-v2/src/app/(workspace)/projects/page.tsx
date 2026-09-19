"use client";

import { Suspense } from "react";
import { ProjectsConsole } from "@/features/projects/components/projects-console";

export default function ProjectsConsolePage() {
  return (
    <Suspense fallback={null}>
      <ProjectsConsole />
    </Suspense>
  );
}
