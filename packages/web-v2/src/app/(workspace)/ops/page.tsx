"use client";

// Workspace-tier Ops monitor (`/ops`, ISS-295) — the single tabbed surface
// (Monitor / Progress / Health / Runs) that replaces the old standalone
// /pipeline,/progress,/health,/runs views.
import { OpsMonitor } from "@/features/pipeline/components/ops-monitor";

export default function OpsPage() {
  return <OpsMonitor />;
}
