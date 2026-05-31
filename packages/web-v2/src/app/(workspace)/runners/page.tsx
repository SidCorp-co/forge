"use client";

import { RunnersScreen } from "@/features/runners/components/runners-screen";

/**
 * `/runners` — unified Runners & devices console. Reconciles the ISS-305
 * browser-approve device-login (pairing) surface with the ISS-296 per-project
 * runner cards (status / model / Claude quota). Consolidates the legacy
 * /devices, /settings/devices and /admin/devices surfaces.
 */
export default function RunnersPage() {
  return <RunnersScreen />;
}
