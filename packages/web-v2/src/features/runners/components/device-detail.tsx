"use client";

import {
	Banner,
	Button,
	EnumBadge,
	EmptyState,
	ErrorState,
	Field,
	HealthDot,
	Icon,
	Input,
	Skeleton,
	SlideOver,
	StatusBadge,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDeviceRunners, useRenameDevice } from "../hooks";
import {
	type DeviceBuildChip,
	type DeviceRow,
	type DeviceRunnerAssignment,
	deviceBinariesRead,
	deviceDiskStale,
	diskRootLine,
	deviceBuildChip,
	deviceGateBanner,
	runnerHealth,
} from "../types";

/** The build chip beside a device's version: amber when an update is pending. */
export function BuildChip({ chip, className = "" }: { chip: DeviceBuildChip; className?: string }) {
	const tone =
		chip.tone === "warning"
			? "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40"
			: "text-muted bg-sunken";
	return (
		<span
			className={`${className}inline-flex items-center rounded px-1.5 py-0.5 text-11 font-medium ${tone}`}
			title={chip.title}
		>
			{chip.label}
		</span>
	);
}

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

/**
 * The binaries this box's panes need and cannot resolve, one hairline row each,
 * with what the box looked for. Every pane it starts fails on any listed here.
 */
function DeviceBinaries({ device }: { device: DeviceRow }) {
	const t = useCopy();
	const read = deviceBinariesRead(device.binaries, useInterfaceLanguage());
	return (
		<div className="flex flex-col gap-1">
			<span className="fg-label">{t("runners.detail.binaries")}</span>
			{read.state === "unreported" && <p className="fg-body-sm text-subtle">{t("runners.detail.binariesUnreported")}</p>}
			{read.state === "resolved" && <p className="fg-body-sm text-subtle">{t("runners.detail.binariesResolved")}</p>}
			{read.state === "missing" && (
				<div className="flex flex-col divide-y divide-line-subtle">
					{read.missing.map((m) => (
						<div key={m.name} className="flex flex-col gap-0.5 py-2">
							<span className="inline-flex items-center gap-2">
								<code className="fg-body-sm font-semibold text-fg">{m.name}</code>
								<span className="fg-caption text-amber-700 dark:text-amber-300">
									{t("runners.detail.missing")}
								</span>
							</span>
							<span className="fg-body-sm text-subtle">{m.detail}</span>
						</div>
					))}
				</div>
			)}
			{read.stale && <p className="fg-caption text-subtle">{read.stale}.</p>}
		</div>
	);
}

/**
 * What each filesystem this box writes its runs' scratch into had left, as core
 * judged it, one hairline row per root. Under the critical threshold a run that
 * cannot create a file fails in whatever way its own tooling fails.
 */
function DeviceDisk({ device }: { device: DeviceRow }) {
	const disk = device.disk;
	const t = useCopy();
	const language = useInterfaceLanguage();
	const stale = disk ? deviceDiskStale(disk, language) : null;
	return (
		<div className="flex flex-col gap-1">
			<span className="fg-label">{t("runners.detail.disk")}</span>
			{disk === null ? (
				<p className="fg-body-sm text-subtle">{t("runners.detail.diskUnreported")}</p>
			) : (
				<div className="flex flex-col divide-y divide-line-subtle">
					{disk.roots.map((r) => (
						<div key={r.root} className="flex flex-col gap-0.5 py-2">
							<span className="inline-flex items-center gap-2">
								<code className="fg-body-sm font-semibold text-fg">{r.root}</code>
								<span
									className={
										r.verdict === "critical"
											? "fg-caption text-danger"
											: r.verdict === "clear"
												? "fg-caption text-subtle"
												: "fg-caption text-amber-700 dark:text-amber-300"
									}
								>
									{t(`runners.disk.verdict.${r.verdict}`)}
									{r.axis && r.verdict !== "clear" ? ` ${t(`runners.disk.on.${r.axis}`)}` : ""}
								</span>
							</span>
							<span className="fg-body-sm text-subtle">{diskRootLine(r, language)}</span>
						</div>
					))}
				</div>
			)}
			{disk && disk.verdict !== "clear" && disk.verdict !== "unmeasurable" && (
				<p className="fg-caption text-subtle">{t("runners.detail.diskThresholds", { tight: disk.tightFreePercent, critical: disk.criticalFreePercent })}</p>
			)}
			{stale && <p className="fg-caption text-subtle">{stale}.</p>}
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
	const t = useCopy();
	const time = useTimeFormat();
	const language = useInterfaceLanguage();
	const buildChip = deviceBuildChip(device, language);
	const gate = deviceGateBanner(device.gate, language);

	return (
		<div className="flex flex-col gap-4">
			{gate && (
				<Banner tone="attention">
					<span>
						<strong>{t("runners.detail.gateHead")}</strong> {t("runners.detail.gateBody", { n: gate.count, rate: gate.rate, window: gate.window })}
						{gate.reason ? ` ${t("runners.detail.gateReason", { reason: gate.reason })}` : ""}
						{gate.stale ? ` ${gate.stale}.` : ""}
					</span>
				</Banner>
			)}
			<div className="flex items-end gap-2">
				<div className="flex-1">
					<Field label={t("runners.detail.name")}>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("runners.detail.name")}
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
					{t("runners.detail.save")}
				</Button>
			</div>

			<div className="flex flex-col divide-y divide-line-subtle">
				<MetaRow label={t("runners.col.status")}>
					<StatusBadge family="device" value={device.status} />
				</MetaRow>
				<MetaRow label={t("runners.col.platform")}>
					<EnumBadge family="platform" value={device.platform} />
				</MetaRow>
				<MetaRow label={t("runners.detail.agentVersion")}>
					<span className="inline-flex items-center gap-2">
						{device.agentVersion ? `v${device.agentVersion}` : t("runners.detail.notReported")}
						{buildChip && <BuildChip chip={buildChip} />}
					</span>
				</MetaRow>
				{buildChip && (
					<MetaRow label={t("runners.detail.build")}>
						{/* The sentence itself, not only a hover: with the commit in play two
						    boxes can share a version and still differ, and a title nobody can
						    reach says nothing to a keyboard or a screen reader (ISS-1165). */}
						<span className="fg-body-sm text-subtle">{buildChip.title}</span>
					</MetaRow>
				)}
				<MetaRow label={t("runners.col.lastSeen")}>{time.relative(device.lastSeenAt) || t("overview.never")}</MetaRow>
				<MetaRow label={t("runners.detail.paired")}>{time.relative(device.pairedAt) || t("overview.never")}</MetaRow>
			</div>

			<DeviceBinaries device={device} />
			<DeviceDisk device={device} />
		</div>
	);
}

/**
 * One project this device serves — READ-ONLY here. Per-project assignment,
 * repo path/branch, and provisioning moved to the project's Settings → Runners
 * tab (`/projects/<slug>/settings?tab=connections#runners`); this is the device-side roll-up
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
				router.push(`/projects/${assignment.slug}/settings?tab=connections#runners`)
			}
			className="flex w-full items-center justify-between gap-2 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
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

export function DeviceDetail({
	device,
	onClose,
}: { device: DeviceRow | null; onClose: () => void }) {
	const runners = useDeviceRunners(device?.id ?? null);
	const rows = runners.data ?? [];
	const t = useCopy();

	return (
		<SlideOver
			open={!!device}
			onClose={onClose}
			title={device?.name ?? t("runners.col.device")}
			width={560}
		>
			{device && (
				<div className="flex flex-col gap-6">
					<DeviceSummary device={device} />

					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-0.5">
							<span className="fg-label">{t("runners.detail.projectsServed")}</span>
							<p className="fg-body-sm text-subtle">{t("runners.detail.projectsServedBody")}</p>
						</div>

						{device.status === "revoked" ? (
							<Banner tone="attention">{t("runners.detail.revoked")}</Banner>
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
								title={t("runners.detail.noProjects")}
								message={t("runners.detail.noProjectsBody")}
								mascot={false}
							/>
						) : (
							<div className="flex flex-col divide-y divide-line-subtle">
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
