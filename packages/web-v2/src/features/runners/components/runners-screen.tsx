"use client";

// web-v2 Runners / devices console (`/v2/runners`). Reconciles two
// implementations of this surface:
//   • ISS-305 — browser-approve device-login pairing (PairPanel) + git push
//     credential, live via the owner's user room.
//   • ISS-296 — device cards listing per-project runners (status / model /
//     activity / Claude quota), offline → ReconnectingBanner, live via each
//     project room.
// Consolidates the legacy /devices, /settings/devices and /admin/devices
// surfaces. Mirrors the prototype RunnersScreen.jsx.
//
// Responsive: card grid collapses to 1-col @375px, runner rows stack, all
// action targets are ≥44px (IconButton min-h-11), no horizontal page scroll,
// min-h-dvh.
import { useMemo } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  ErrorState,
  ProjectCardSkeleton,
} from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom, userRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { DeviceCard, NoDevices } from "./device-card";
import { PairPanel } from "./pair-panel";
import { RunnerRow } from "./runner-row";
import { useAllRunners, useMyDevices } from "../hooks";

/** Zero-render WS room subscription — fans live updates across visible projects. */
function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function RunnersScreen() {
  const { user } = useAuth();
  // ISS-305 — live pending→approved + revoke ride the owner's user room.
  useRoom(user?.id ? userRoom(user.id) : null);

  const devicesQ = useMyDevices();
  const projectsQ = useProjects();

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

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      {projects.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="mb-6">
        <h1 className="fg-h2">Runners &amp; devices</h1>
        <p className="fg-body-sm mt-1">
          Your paired devices and their per-project runners — pairing, status, model, and Claude
          quota. Status updates live.
        </p>
      </header>

      <div className="mb-6">
        <PairPanel />
      </div>

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
        <NoDevices />
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
    </div>
  );
}
