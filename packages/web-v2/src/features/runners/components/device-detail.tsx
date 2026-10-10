"use client";

import {
  Banner,
  Button,
  EnumBadge,
  EmptyState,
  Field,
  HealthDot,
  Icon,
  Input,
  SlideOver,
  StatusBadge,
  Property,
  PropertyList,
} from "@/design";
import Link from "next/link";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
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
			? "text-warn-11 bg-warn-3"
			: "text-muted bg-sunken";
	return (
		<span
			className={`${className}inline-flex items-center rounded px-1.5 py-0.5 text-12 font-medium ${tone}`}
			title={chip.title}
		>
			{chip.label}
		</span>
	);
}

interface ReadEntry {
	key: string;
	verdict: string;
	tone: string;
	detail: string;
}

/** A label, then one hairline row per thing the box reported (its name, core's verdict, the detail), then the notes under them. */
function DeviceRead({ label, entries, empty, notes }: { label: string; entries: ReadEntry[] | null; empty: string; notes: (string | null | false)[] }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="fg-label">{label}</span>
			{entries === null || entries.length === 0 ? <p className="fg-body-sm text-subtle">{empty}</p> : (
				<div className="flex flex-col divide-y divide-line-subtle">
					{entries.map((e) => (
						<div key={e.key} className="flex flex-col gap-0.5 py-2">
							<span className="inline-flex items-center gap-2">
								<code className="fg-body-sm font-semibold text-fg">{e.key}</code>
								<span className={`fg-caption ${e.tone}`}>{e.verdict}</span>
							</span>
							<span className="fg-body-sm text-subtle">{e.detail}</span>
						</div>
					))}
				</div>
			)}
			{notes.filter(Boolean).map((n) => <p key={n as string} className="fg-caption text-subtle">{n}</p>)}
		</div>
	);
}

/** The binaries this box's panes need and cannot resolve, with what it looked for: every pane it starts fails on any listed. */
function DeviceBinaries({ device }: { device: DeviceRow }) {
	const t = useCopy();
	const read = deviceBinariesRead(device.binaries, useInterfaceLanguage());
	const empty = read.state === "unreported" ? t("runners.detail.binariesUnreported") : t("runners.detail.binariesResolved");
	const entries = read.missing.map((m) => ({ key: m.name, verdict: t("runners.detail.missing"), tone: "text-warn-11", detail: m.detail }));
	return <DeviceRead label={t("runners.detail.binaries")} entries={entries} empty={empty} notes={[read.stale && `${read.stale}.`]} />;
}

const VERDICT_TONE: Record<string, string> = { critical: "text-danger", clear: "text-subtle" };

/** What each filesystem this box writes its runs' scratch into had left, as core judged it; under the critical threshold a run fails however its own tooling fails. */
function DeviceDisk({ device }: { device: DeviceRow }) {
	const disk = device.disk;
	const t = useCopy();
	const language = useInterfaceLanguage();
	const stale = disk ? deviceDiskStale(disk, language) : null;
	const entries = disk?.roots.map((r) => ({
		key: r.root,
		verdict: `${t(`runners.disk.verdict.${r.verdict}`)}${r.axis && r.verdict !== "clear" ? ` ${t(`runners.disk.on.${r.axis}`)}` : ""}`,
		tone: VERDICT_TONE[r.verdict] ?? "text-warn-11",
		detail: diskRootLine(r, language),
	})) ?? null;
	const thresholds = disk && disk.verdict !== "clear" && disk.verdict !== "unmeasurable" && t("runners.detail.diskThresholds", { tight: disk.tightFreePercent, critical: disk.criticalFreePercent });
	return <DeviceRead label={t("runners.detail.disk")} entries={entries} empty={t("runners.detail.diskUnreported")} notes={[thresholds, stale && `${stale}.`]} />;
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

			<PropertyList>
				<Property label={t("runners.col.status")}>
					<StatusBadge family="device" value={device.status} />
				</Property>
				<Property label={t("runners.col.platform")}>
					<EnumBadge family="platform" value={device.platform} />
				</Property>
				<Property label={t("runners.detail.agentVersion")}>
					<span className="inline-flex items-center gap-2">
						{device.agentVersion ? `v${device.agentVersion}` : t("runners.detail.notReported")}
						{buildChip && <BuildChip chip={buildChip} />}
					</span>
				</Property>
				{buildChip && (
					<Property label={t("runners.detail.build")}>
						{/* The sentence itself, not only a hover: with the commit in play two
						    boxes can share a version and still differ, and a title nobody can
						    reach says nothing to a keyboard or a screen reader (ISS-1165). */}
						<span className="fg-body-sm text-subtle">{buildChip.title}</span>
					</Property>
				)}
				<Property label={t("runners.col.lastSeen")}>{time.relative(device.lastSeenAt) || t("overview.never")}</Property>
				<Property label={t("runners.detail.paired")}>{time.relative(device.pairedAt) || t("overview.never")}</Property>
			</PropertyList>

			<DeviceBinaries device={device} />
			<DeviceDisk device={device} />
		</div>
	);
}

/** One project this device serves, read-only: assignment, repo path and provisioning live on the project's Settings → Runners, which this links to. */
function ProjectPool({ assignment }: { assignment: DeviceRunnerAssignment }) {
	return (
		<Link
			href={`/projects/${assignment.slug}/settings?tab=connections#runners`}
			className="flex w-full items-center justify-between gap-2 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
		>
			<div className="flex min-w-0 items-center gap-2">
				<HealthDot health={runnerHealth(assignment.status)} withLabel={false} />
				<span className="truncate font-semibold text-fg">{assignment.name}</span>
			</div>
			<div className="flex flex-none items-center gap-2">
				{assignment.repoPath && <code className="fg-caption max-w-50 truncate text-subtle">{assignment.repoPath}</code>}
				<Icon name="arrowRight" size={14} className="text-subtle" />
			</div>
		</Link>
	);
}

export function DeviceDetail({
	device,
	onClose,
}: { device: DeviceRow | null; onClose: () => void }) {
	const runners = useDeviceRunners(device?.id ?? null);
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
						<span className="fg-label">{t("runners.detail.projectsServed")}</span>

						{device.status === "revoked" ? (
							<Banner tone="attention">{t("runners.detail.revoked")}</Banner>
						) : (
							<QueryBoundary query={runners} loadingLabel={t("runners.detail.projectsServed")} height="inline">
								{(rows) => rows.length === 0 ? <EmptyState message={t("runners.detail.noProjects")} mascot={false} /> : (
									<div className="flex flex-col divide-y divide-line-subtle">
										{rows.map((r) => <ProjectPool key={r.runnerId} assignment={r} />)}
									</div>
								)}
							</QueryBoundary>
						)}
					</div>
				</div>
			)}
		</SlideOver>
	);
}
