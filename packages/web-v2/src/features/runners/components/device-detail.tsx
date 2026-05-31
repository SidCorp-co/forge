"use client";

import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Field,
  HealthDot,
  Icon,
  Input,
  MonoTag,
  Select,
  Skeleton,
  SlideOver,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useProject, useProjects } from "@/features/projects/hooks";
import {
  useBindRunner,
  useDeviceRunners,
  usePatchRunner,
  useRenameDevice,
  useUnbindRunner,
} from "../hooks";
import { deviceHealth, runnerHealth, type DeviceRow, type DeviceRunnerAssignment } from "../types";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A label/value row in the device summary grid. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="fg-body-sm text-subtle">{label}</span>
      <span className="fg-body-sm text-fg">{children}</span>
    </div>
  );
}

/** Rename + read-only status/config for the device. */
function DeviceSummary({ device }: { device: DeviceRow }) {
  const rename = useRenameDevice();
  const [name, setName] = useState(device.name);
  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== device.name;
  const revoked = device.status === "revoked";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Device name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Device name"
              maxLength={80}
              disabled={revoked}
            />
          </Field>
        </div>
        <Button
          variant="secondary"
          icon="check"
          loading={rename.isPending}
          disabled={!dirty || revoked}
          onClick={() => rename.mutate({ id: device.id, name: trimmed })}
        >
          Save
        </Button>
      </div>

      <div className="rounded-lg border border-line bg-sunken px-3 py-1.5">
        <MetaRow label="Status">
          <span className="inline-flex items-center gap-1.5 capitalize">
            <HealthDot health={deviceHealth(device.status)} />
            {device.status}
          </span>
        </MetaRow>
        <MetaRow label="Platform">
          <MonoTag>{device.platform}</MonoTag>
        </MetaRow>
        <MetaRow label="Agent version">
          {device.agentVersion ? `v${device.agentVersion}` : "—"}
        </MetaRow>
        <MetaRow label="Git push">
          {device.gitCredentialRef ? (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="check" size={14} className="text-[color:var(--green-600)]" />
              provisioned
            </span>
          ) : (
            "none"
          )}
        </MetaRow>
        <MetaRow label="Last seen">{relativeTime(device.lastSeenAt)}</MetaRow>
        <MetaRow label="Paired">{relativeTime(device.pairedAt)}</MetaRow>
      </div>
    </div>
  );
}

/** One project-pool assignment — editable per-device repo path/branch + unassign. */
function RunnerRow({
  deviceId,
  assignment,
}: {
  deviceId: string;
  assignment: DeviceRunnerAssignment;
}) {
  const patch = usePatchRunner(deviceId);
  const unbind = useUnbindRunner(deviceId);
  const [repoPath, setRepoPath] = useState(assignment.repoPath ?? "");
  const [branch, setBranch] = useState(assignment.branch ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dirty =
    repoPath !== (assignment.repoPath ?? "") || branch !== (assignment.branch ?? "");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <HealthDot health={runnerHealth(assignment.status)} />
          <span className="truncate font-semibold text-fg">{assignment.name}</span>
        </div>
        {confirmRemove ? (
          <span className="inline-flex items-center gap-1.5">
            <Button
              variant="danger"
              size="sm"
              icon="trash"
              loading={unbind.isPending}
              onClick={() =>
                unbind.mutate(
                  { projectId: assignment.projectId, runnerId: assignment.runnerId },
                  { onSettled: () => setConfirmRemove(false) },
                )
              }
            >
              Remove
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            onClick={() => setConfirmRemove(true)}
          >
            Unassign
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Repo path">
          <Input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder={assignment.projectDefaultRepoPath ?? "/absolute/path/on/this/device"}
            spellCheck={false}
          />
        </Field>
        <Field label="Branch">
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={assignment.baseBranch ?? "main"}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="fg-caption text-subtle">
          Absolute path on this device — typed manually, the browser can&apos;t browse its
          filesystem.
        </p>
        <Button
          variant="secondary"
          size="sm"
          loading={patch.isPending}
          disabled={!dirty}
          onClick={() =>
            patch.mutate({
              projectId: assignment.projectId,
              runnerId: assignment.runnerId,
              repoPath: repoPath.trim() || null,
              branch: branch.trim() || null,
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/** Assign an unassigned project as a new pool for this device. */
function AssignProject({
  deviceId,
  assigned,
}: {
  deviceId: string;
  assigned: DeviceRunnerAssignment[];
}) {
  const { user } = useAuth();
  const projects = useProjects();
  const bind = useBindRunner(deviceId);
  const [projectId, setProjectId] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const assignedIds = useMemo(
    () => new Set(assigned.map((a) => a.projectId)),
    [assigned],
  );

  // Mirror the POST /:id/runners authz: owner OR project owner/admin may bind.
  const available = useMemo(
    () =>
      (projects.data ?? []).filter((p) => {
        if (assignedIds.has(p.id)) return false;
        return p.ownerId === user?.id || p.role === "owner" || p.role === "admin";
      }),
    [projects.data, user?.id, assignedIds],
  );

  // Prefill the path from the selected project's default repoPath once detail loads.
  const detail = useProject(projectId || undefined);
  if (projectId && detail.data && seededFor !== projectId) {
    setRepoPath(detail.data.repoPath ?? "");
    setSeededFor(projectId);
  }

  if (available.length === 0) {
    return (
      <p className="fg-body-sm text-subtle">
        All of your projects are already assigned to this device.
      </p>
    );
  }

  const options = [
    { value: "", label: "Select a project…" },
    ...available.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-line-strong p-3">
      <span className="fg-label">Assign a project</span>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project">
          <Select options={options} value={projectId} onChange={setProjectId} />
        </Field>
        <Field label="Repo path">
          <Input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder={detail.data?.repoPath ?? "/absolute/path/on/this/device"}
            disabled={!projectId}
            spellCheck={false}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          loading={bind.isPending}
          disabled={!projectId}
          onClick={() =>
            bind.mutate(
              { projectId, repoPath: repoPath.trim() || null },
              {
                onSuccess: () => {
                  setProjectId("");
                  setRepoPath("");
                  setSeededFor(null);
                },
              },
            )
          }
        >
          Assign
        </Button>
      </div>
    </div>
  );
}

/**
 * Device detail slide-over — rename, per-device status/config, and the project
 * pools (runner bindings) this device serves. Attaches to the Runners
 * destination; no new route or sidebar item. Mirrors v1's
 * `settings/devices/[id]` page, rebuilt on web-v2 kit primitives.
 */
export function DeviceDetail({ device, onClose }: { device: DeviceRow | null; onClose: () => void }) {
  const runners = useDeviceRunners(device?.id ?? null);
  const rows = runners.data ?? [];

  return (
    <SlideOver open={!!device} onClose={onClose} title={device?.name ?? "Device"} width={560}>
      {device && (
        <div className="flex flex-col gap-6">
          <DeviceSummary device={device} />

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="fg-label">Project pools</span>
              <p className="fg-body-sm text-subtle">
                Projects this device runs agents for. Each has its own repo path on this machine.
              </p>
            </div>

            {device.status === "revoked" ? (
              <Banner tone="attention">
                This device is revoked — its runner bindings were removed and it can no longer
                accept jobs.
              </Banner>
            ) : runners.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : runners.isError ? (
              <ErrorState
                message={formatApiError(runners.error)}
                onRetry={() => runners.refetch()}
              />
            ) : rows.length === 0 ? (
              <EmptyState
                title="No projects assigned"
                message="Assign a project below to give this device a runner pool."
                mascot={false}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {rows.map((r) => (
                  <RunnerRow key={r.runnerId} deviceId={device.id} assignment={r} />
                ))}
              </div>
            )}

            {device.status !== "revoked" && (
              <AssignProject deviceId={device.id} assigned={rows} />
            )}
          </div>
        </div>
      )}
    </SlideOver>
  );
}
