"use client";

// web-v2 Runners / devices console (`/v2/runners`). Consolidates the legacy
// /devices, /settings/devices and /admin/devices surfaces. Lists the caller's
// real devices with their per-project runners (status / model / activity /
// Claude quota), a Pair-a-device flow, offline → ReconnectingBanner, skeleton +
// EmptyState, and live updates via WS. Mirrors the prototype RunnersScreen.jsx.
//
// Responsive: card grid collapses to 1-col @375px, runner rows stack, all
// action targets are ≥44px (IconButton min-h-11), no horizontal page scroll,
// min-h-dvh.
import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  ErrorState,
  ProjectCardSkeleton,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { DeviceCard, NoDevices } from "./device-card";
import { PairDeviceModal } from "./pair-device-modal";
import { RunnerRow } from "./runner-row";
import { useAllRunners, useMyDevices } from "../hooks";

/** Zero-render WS room subscription — fans live updates across visible projects. */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function RunnersScreen() {
  const devicesQ = useMyDevices();
  const projectsQ = useProjects();
  const [pairOpen, setPairOpen] = useState(false);

  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const runnersQ = useAllRunners(projectIds);

  // Group runners under their device; deviceId === null ⇒ remote runners.
  const { byDevice, remote } = useMemo(() => {
    const byDevice: Record<string, typeof runnersQ.runners> = {};
    const remote: typeof runnersQ.runners = [];
    for (const r of runnersQ.runners) {
      if (r.deviceId) (byDevice[r.deviceId] ??= []).push(r);
      else remote.push(r);
    }
    return { byDevice, remote };
  }, [runnersQ.runners]);

  const devices = devicesQ.data ?? [];
  const loading = devicesQ.isLoading || (projectsQ.isLoading && projectIds.length === 0);
  const projectOptions = projects.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      {projects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Runners</h1>
          <p className="fg-body-sm mt-1">
            Your devices and their per-project runners — status, model, and Claude quota.
          </p>
        </div>
        <Button variant="primary" size="sm" icon="plus" onClick={() => setPairOpen(true)}>
          Pair a device
        </Button>
      </header>

      {loading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && devicesQ.isError && (
        <ErrorState
          title="Couldn't load devices"
          message="We couldn't reach the device service. Retry in a moment."
          onRetry={() => devicesQ.refetch()}
        />
      )}

      {/*
        A per-project `GET /api/runners` failure only zeroes that project's
        runner list (runnersQ.runners flatMaps `?? []`), so without this notice
        a failing project's runners would silently vanish. Surface it instead.
      */}
      {!loading && !devicesQ.isError && runnersQ.isError && (
        <div className="mb-4">
          <Banner
            tone="attention"
            action={
              <Button variant="ghost" size="sm" onClick={() => runnersQ.refetch()}>
                Retry
              </Button>
            }
          >
            Some projects&rsquo; runners couldn&rsquo;t be loaded — their device cards may show fewer runners than expected.
          </Banner>
        </div>
      )}

      {!loading && !devicesQ.isError && devices.length === 0 && remote.length === 0 && (
        <NoDevices onPair={() => setPairOpen(true)} />
      )}

      {!loading && !devicesQ.isError && (devices.length > 0 || remote.length > 0) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              runners={byDevice[device.id] ?? []}
              projectNames={projectNames}
            />
          ))}

          {remote.length > 0 && (
            <Card>
              <CardContent>
                <div className="flex items-center gap-2.5">
                  <span className="fg-body-sm font-semibold text-fg">Remote runners</span>
                  <span className="fg-caption">· not bound to a device</span>
                </div>
                <div className="mt-3 space-y-2">
                  {remote.map((r) => (
                    <RunnerRow key={r.id} runner={r} projectName={projectNames[r.projectId] ?? "Unknown project"} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <PairDeviceModal open={pairOpen} onClose={() => setPairOpen(false)} projects={projectOptions} />
    </div>
  );
}
