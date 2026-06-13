"use client";

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
	Skeleton,
	SlideOver,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDeviceRunners, useRenameDevice } from "../hooks";
import {
	type DeviceRow,
	type DeviceRunnerAssignment,
	deviceHealth,
	runnerHealth,
} from "../types";

/** A label/value row in the device summary grid. */
function MetaRow({
	label,
	children,
}: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 py-1.5">
			<span className="fg-body-sm text-subtle">{label}</span>
			<span className="fg-body-sm text-fg">{children}</span>
		</div>
	);
}

/** Rename + read-only status/config for the device (device-global concerns). */
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
					<span className="inline-flex items-center gap-2">
						{device.agentVersion ? `v${device.agentVersion}` : "—"}
						{device.agentOutdated && (
							<span
								className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40"
								title={
									device.latestAgentVersion
										? `Update pending — latest is v${device.latestAgentVersion}`
										: "Update pending"
								}
							>
								update pending
							</span>
						)}
					</span>
				</MetaRow>
				<MetaRow label="Git push">
					{device.gitCredentialRef ? (
						<span className="inline-flex items-center gap-1.5">
							<Icon
								name="check"
								size={14}
								className="text-[color:var(--green-600)]"
							/>
							provisioned
						</span>
					) : (
						"none"
					)}
				</MetaRow>
				<MetaRow label="Last seen">
					{formatRelativeTime(device.lastSeenAt, { emptyLabel: "never" })}
				</MetaRow>
				<MetaRow label="Paired">
					{formatRelativeTime(device.pairedAt, { emptyLabel: "never" })}
				</MetaRow>
			</div>
		</div>
	);
}

/**
 * One project this device serves — READ-ONLY here. Per-project assignment,
 * repo path/branch, and provisioning moved to the project's Settings → Runners
 * tab (`/projects/<slug>/settings?tab=runners`); this is the device-side roll-up
 * that links there.
 */
function ProjectPoolRow({
	assignment,
}: { assignment: DeviceRunnerAssignment }) {
	const router = useRouter();
	return (
		<button
			type="button"
			onClick={() =>
				router.push(`/projects/${assignment.slug}/settings?tab=runners`)
			}
			className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
		>
			<div className="flex min-w-0 items-center gap-2">
				<HealthDot health={runnerHealth(assignment.status)} withLabel={false} />
				<span className="truncate font-semibold text-fg">
					{assignment.name}
				</span>
			</div>
			<div className="flex flex-none items-center gap-2">
				{assignment.repoPath && (
					<code className="fg-caption max-w-[200px] truncate text-subtle">
						{assignment.repoPath}
					</code>
				)}
				<Icon name="arrowRight" size={14} className="text-subtle" />
			</div>
		</button>
	);
}

/**
 * Device detail slide-over — device-global concerns only (rename, status). The
 * "project pools" list is now a read-only roll-up: assigning a device to a
 * project, its repo path, and provisioning all live on the project's Runners
 * screen. Attaches to the Runners destination; no new route.
 */
export function DeviceDetail({
	device,
	onClose,
}: { device: DeviceRow | null; onClose: () => void }) {
	const runners = useDeviceRunners(device?.id ?? null);
	const rows = runners.data ?? [];

	return (
		<SlideOver
			open={!!device}
			onClose={onClose}
			title={device?.name ?? "Device"}
			width={560}
		>
			{device && (
				<div className="flex flex-col gap-6">
					<DeviceSummary device={device} />

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-0.5">
							<span className="fg-label">Projects served</span>
							<p className="fg-body-sm text-subtle">
								Read-only. Assign this device, set its repo path, and watch
								provisioning on each project&apos;s Runners page.
							</p>
						</div>

						{device.status === "revoked" ? (
							<Banner tone="attention">
								This device is revoked — its runner bindings were removed and it
								can no longer accept jobs.
							</Banner>
						) : runners.isLoading ? (
							<div className="flex flex-col gap-2">
								<Skeleton className="h-14 w-full" />
								<Skeleton className="h-14 w-full" />
							</div>
						) : runners.isError ? (
							<ErrorState
								message={formatApiError(runners.error)}
								onRetry={() => runners.refetch()}
							/>
						) : rows.length === 0 ? (
							<EmptyState
								title="No projects assigned"
								message="Assign this device from a project's Runners page to give it a pool."
								mascot={false}
							/>
						) : (
							<div className="flex flex-col gap-2">
								{rows.map((r) => (
									<ProjectPoolRow key={r.runnerId} assignment={r} />
								))}
							</div>
						)}
					</div>
				</div>
			)}
		</SlideOver>
	);
}
