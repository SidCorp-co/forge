'use client';

import { ArrowLeft, Check, ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, Input, Label, Select } from '@/components/ui';
import { useDeviceRunners, useMyDevices } from '@/features/device/hooks/use-devices';
import type { DeviceRunnerAssignment } from '@/features/device/types';
import { useMeProfile } from '@/features/me/hooks/use-me';
import {
  useBindRunner,
  usePatchRunner,
  useProject,
  useProjects,
} from '@/features/project/hooks/use-projects';
import { useBulkPushSkills, useDeviceSkillStatus } from '@/features/skill/hooks/use-skills';
import type { DeviceSkillStatusEntry } from '@/features/skill/types';
import { useSetPageTitle } from '@/hooks/use-page-title';

// Reused from the devices list page — keep the colour map in sync so a device
// reads identically on both screens.
const STATUS_PILLS: Record<string, string> = {
  online: 'bg-success-surface text-success border-success/30',
  offline: 'bg-surface-container-high text-on-surface-variant border-outline-variant/30',
  revoked: 'bg-danger-surface text-danger border-danger/30',
  draining: 'bg-surface-container-high text-on-surface-variant border-outline-variant/30',
  disabled: 'bg-surface-container-high text-on-surface-variant border-outline-variant/30',
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border ${
        STATUS_PILLS[status] ?? STATUS_PILLS.offline
      }`}
    >
      {status}
    </span>
  );
}

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  useSetPageTitle('Device');

  const { data: devices } = useMyDevices();
  const device = useMemo(
    () => (devices ?? []).find((d) => d.id === deviceId),
    [devices, deviceId],
  );
  const {
    data: runners,
    isLoading,
    error,
  } = useDeviceRunners(deviceId);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6 space-y-6">
      <div>
        <Link
          href="/settings/devices"
          className="inline-flex items-center gap-1.5 text-xs text-outline hover:text-on-surface"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to devices
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-xl font-semibold text-on-surface">
            {device?.name ?? 'Device'}
          </h1>
          {device && <StatusPill status={device.status} />}
        </div>
        <p className="mt-1 text-xs text-outline">
          {device ? (
            <>
              <span className="capitalize">{device.platform}</span> · projects this device runs
              agents for. Each project has its own repo path on this machine.
            </>
          ) : (
            'Projects this device runs agents for.'
          )}
        </p>
      </div>

      {error && (
        <div className="rounded border border-danger/40 bg-danger-surface/40 p-3 text-sm text-danger">
          Failed to load assignments.
        </div>
      )}

      {isLoading && <p className="text-sm text-outline">Loading assignments…</p>}

      {!isLoading && runners && runners.length === 0 && (
        <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-8 text-center">
          <p className="text-sm text-on-surface-variant">
            No projects assigned to this device yet.
          </p>
          <p className="mt-2 text-xs text-outline">Assign one below to set its repo path.</p>
        </div>
      )}

      {runners && runners.length > 0 && (
        <div className="space-y-3">
          {runners.map((r) => (
            <RunnerRow key={r.runnerId} assignment={r} deviceId={deviceId} />
          ))}
        </div>
      )}

      <AssignProject deviceId={deviceId} assigned={runners ?? []} />
    </div>
  );
}

function RunnerRow({
  assignment,
  deviceId,
}: {
  assignment: DeviceRunnerAssignment;
  deviceId: string;
}) {
  const patchRunner = usePatchRunner();
  const [repoPath, setRepoPath] = useState(assignment.repoPath ?? '');
  const [branch, setBranch] = useState(assignment.branch ?? '');
  const [saved, setSaved] = useState(false);

  const dirty =
    repoPath !== (assignment.repoPath ?? '') || branch !== (assignment.branch ?? '');

  const onSave = async () => {
    setSaved(false);
    await patchRunner.mutateAsync({
      projectId: assignment.projectId,
      runnerId: assignment.runnerId,
      body: {
        repoPath: repoPath.trim() || null,
        branch: branch.trim() || null,
      },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="rounded-sm border border-outline-variant/30 bg-surface-container-low p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-on-surface">{assignment.name}</span>
        <StatusPill status={assignment.status} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div>
          <Label htmlFor={`path-${assignment.runnerId}`}>Repo path</Label>
          <Input
            id={`path-${assignment.runnerId}`}
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder={assignment.projectDefaultRepoPath ?? '/absolute/path/on/this/device'}
            spellCheck={false}
          />
        </div>
        <div>
          <Label htmlFor={`branch-${assignment.runnerId}`}>Branch</Label>
          <Input
            id={`branch-${assignment.runnerId}`}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={assignment.baseBranch ?? 'main'}
            spellCheck={false}
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-outline">
          Absolute path on this device — typed manually, the browser can&apos;t browse its
          filesystem.
        </p>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-[10px] text-success">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={!dirty || patchRunner.isPending}
          >
            {patchRunner.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <RunnerSkills assignment={assignment} deviceId={deviceId} />
    </div>
  );
}

const SKILL_STATUS_STYLES: Record<DeviceSkillStatusEntry['status'], string> = {
  synced: 'border-success/30 bg-success-surface/40 text-success',
  outdated: 'border-warning/30 bg-warning-dim/10 text-warning',
  missing: 'border-outline-variant/40 bg-surface-container text-outline',
};

function skillStatusLabel(s: DeviceSkillStatusEntry): string {
  if (s.status === 'synced') return `synced (v${s.installedVersion ?? '?'})`;
  if (s.status === 'missing') return 'missing';
  return `outdated (v${s.installedVersion ?? '?'})`;
}

/**
 * Skill Studio 5 (ISS-279) — by-device view: this device × this project's
 * skills with installedVersion + sync status, a per-skill Sync, and a
 * cross-link back to Studio (`?skill=` deep-link).
 */
function RunnerSkills({
  assignment,
  deviceId,
}: {
  assignment: DeviceRunnerAssignment;
  deviceId: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useDeviceSkillStatus(
    open ? assignment.projectId : undefined,
    open ? deviceId : undefined,
  );
  const bulkPush = useBulkPushSkills();
  const [syncingSkill, setSyncingSkill] = useState<string | null>(null);

  const skills = data?.skills ?? [];
  const outdated = skills.filter((s) => s.status !== 'synced').length;

  function syncSkill(name?: string) {
    setSyncingSkill(name ?? '*');
    bulkPush.mutate(
      {
        targets: ['dev'],
        projectDocumentId: assignment.projectId,
        skillNames: name ? [name] : undefined,
        deviceId,
      },
      { onSettled: () => setSyncingSkill(null) },
    );
  }

  return (
    <div className="border-t border-outline-variant/20 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-outline hover:text-on-surface"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Skills
        {open && skills.length > 0 && (
          <span className="ml-1 normal-case tracking-normal text-outline">
            {outdated > 0 ? `· ${outdated} out of sync` : '· all in sync'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {isLoading && <p className="text-[11px] text-outline">Loading skills…</p>}
          {error && (
            <p className="text-[11px] text-danger">Failed to load skill status.</p>
          )}
          {!isLoading && !error && skills.length === 0 && (
            <p className="text-[11px] text-outline">No skills registered for this project.</p>
          )}
          {skills.map((s) => {
            const skillSyncing = bulkPush.isPending && syncingSkill === s.name;
            return (
              <div
                key={s.skillId}
                className="flex items-center justify-between gap-2 rounded border border-outline-variant/20 bg-surface-container/40 px-2 py-1"
              >
                <Link
                  href={`/projects/${assignment.slug}/skills?skill=${s.skillId}`}
                  className="flex min-w-0 items-center gap-2 text-xs text-on-surface-variant hover:text-on-surface"
                  title="Open in Skill Studio"
                >
                  <span className="truncate font-medium">{s.name}</span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${SKILL_STATUS_STYLES[s.status]}`}
                  >
                    {skillStatusLabel(s)}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => syncSkill(s.name)}
                  disabled={bulkPush.isPending || s.status === 'synced'}
                  title={s.status === 'synced' ? 'In sync' : 'Push this skill'}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface hover:bg-surface-container disabled:opacity-40"
                >
                  <RefreshCw className={`h-3 w-3 ${skillSyncing ? 'animate-spin' : ''}`} />
                  Sync
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssignProject({
  deviceId,
  assigned,
}: {
  deviceId: string;
  assigned: DeviceRunnerAssignment[];
}) {
  const { data: projects } = useProjects();
  const me = useMeProfile();
  const bindRunner = useBindRunner();

  const assignedIds = useMemo(
    () => new Set(assigned.map((a) => a.projectId)),
    [assigned],
  );
  // Mirror the POST /:id/runners authz: owner OR project admin may bind. The
  // list route returns `role` per project (typed loosely on the row), so admins
  // who aren't owners can still assign from here.
  const available = useMemo(
    () =>
      (projects ?? []).filter((p) => {
        if (!me.data || assignedIds.has(p.id)) return false;
        const role = (p as { role?: string | null }).role;
        return p.ownerId === me.data.id || role === 'owner' || role === 'admin';
      }),
    [projects, me.data, assignedIds],
  );

  const [projectId, setProjectId] = useState('');
  const [repoPath, setRepoPath] = useState('');
  // The /projects list projection omits repoPath, so read it from the selected
  // project's detail (GET /projects/:id returns repoPath) to prefill the path.
  const { data: selectedDetail } = useProject(projectId || undefined);

  // Prefill the path from the project's default repoPath once its detail loads.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (projectId && selectedDetail && seededFor !== projectId) {
    setRepoPath(selectedDetail.repoPath ?? '');
    setSeededFor(projectId);
  }

  const onAssign = async () => {
    if (!projectId) return;
    await bindRunner.mutateAsync({
      projectId,
      body: { deviceId, repoPath: repoPath.trim() || null },
    });
    setProjectId('');
    setRepoPath('');
    setSeededFor(null);
  };

  // Wait for the profile before deciding there's nothing to assign — otherwise
  // `available` is momentarily [] and the empty state flashes on first paint.
  if (!me.data) return null;

  if (available.length === 0) {
    return (
      <p className="text-xs text-outline">
        All of your projects are already assigned to this device.
      </p>
    );
  }

  return (
    <div className="rounded-sm border border-dashed border-outline-variant/40 p-4 space-y-3">
      <h2 className="text-sm font-medium text-on-surface">Assign a project</h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <div>
          <Label htmlFor="assign-project">Project</Label>
          <Select
            id="assign-project"
            className="w-full"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Select a project…</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="assign-path">Repo path</Label>
          <Input
            id="assign-path"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder={selectedDetail?.repoPath ?? '/absolute/path/on/this/device'}
            disabled={!projectId}
            spellCheck={false}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => void onAssign()}
          disabled={!projectId || bindRunner.isPending}
        >
          <Plus className="h-4 w-4" />
          {bindRunner.isPending ? 'Assigning…' : 'Assign'}
        </Button>
      </div>
    </div>
  );
}
