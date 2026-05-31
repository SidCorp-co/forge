"use client";

// web-v2 PM agent console (`/v2/projects/[slug]/pm`). Tabs: Overview (derived
// snapshot + runner load), Dependencies (client-derived graph + editing +
// dispatch), Decisions, Policies, Config. Subscribes to the project WS room so
// decisions / dependency / runner changes refresh live. Reuses Tabs from
// @/design; tab bodies reuse Table / Menu / PipelineTracker.
import { useState } from "react";
import { Tabs, type TabItem } from "@/design";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { PmConfig } from "./pm-config";
import { PmDecisions } from "./pm-decisions";
import { PmDependencies } from "./pm-dependencies";
import { PmOverview } from "./pm-overview";
import { PmPolicies } from "./pm-policies";

const TABS: TabItem[] = [
  { value: "overview", label: "Overview" },
  { value: "dependencies", label: "Dependencies" },
  { value: "decisions", label: "Decisions" },
  { value: "policies", label: "Policies" },
  { value: "config", label: "Config" },
];

export function PmScreen({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [tab, setTab] = useState("overview");
  useRoom(projectRoom(projectId));

  return (
    <div className="mx-auto w-full min-h-dvh max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-5">
        <h1 className="fg-h2">PM agent</h1>
        <p className="fg-body-sm mt-1">Autonomous project management for {projectName}.</p>
      </header>

      <div className="mb-6 overflow-x-auto">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "overview" && <PmOverview projectId={projectId} />}
      {tab === "dependencies" && <PmDependencies projectId={projectId} />}
      {tab === "decisions" && <PmDecisions projectId={projectId} />}
      {tab === "policies" && <PmPolicies projectId={projectId} />}
      {tab === "config" && <PmConfig projectId={projectId} />}
    </div>
  );
}
