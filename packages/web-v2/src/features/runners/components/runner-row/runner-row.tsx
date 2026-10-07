import {
	Badge,
	Banner,
	Button,
	EnumBadge,
	HealthDot,
	Icon,
	enumLabel,
	useNow,
} from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useState } from "react";
import { useClearRunnerError } from "../../hooks";
import {
	type ActiveRunnerJob,
	type ProjectRunner,
	type RunnerLimitDisplay,
	formatElapsed,
	provisionHealth,
	runnerLimitDisplay,
	runnerLimitLine,
	runnerVersionLabel,
} from "../../types";
import { PoolAdmission } from "../pool-admission";
import { PoolReadBanner } from "../pool-read";
import { ResidentMaster } from "../resident-master";
import { RunnerLabels } from "../runner-labels";
import { ProvisionStepper } from "./provision-stepper";
import { RunnerActivityPanel } from "./runner-activity-panel";
import { RunnerRowActions } from "./runner-row-actions";

/** One assigned device row + its provision stepper + actions. */
export function RunnerRow({
	runner,
	current,
	projectId,
	canEdit,
	slug,
}: {
	runner: ProjectRunner;
	/** The job this runner is executing right now, or null when idle. */
	current: ActiveRunnerJob | null;
	projectId: string;
	canEdit: boolean;
	/** The project slug, as `forge-runner master stand-down` takes it. */
	slug: string | undefined;
}) {
	const [showActivity, setShowActivity] = useState(false);
	const deviceDisabled = Boolean(runner.deviceDisabledAt);
	// Tick once a second while this runner is limited (live next-try countdown) OR
	// busy (live elapsed counter on the current job).
	const now = useNow(1000, Boolean(runner.limitReason) || Boolean(current));
	const t = useCopy();
	const time = useTimeFormat();
	const limit = runnerLimitDisplay(runner, useInterfaceLanguage(), now);

	return (
		<div className="flex flex-col gap-3 py-3">
			<div className="flex items-center justify-between gap-2">
				<RunnerHeading runner={runner} limit={limit} deviceDisabled={deviceDisabled} />
				{canEdit && (
					<RunnerRowActions runner={runner} projectId={projectId} deviceDisabled={deviceDisabled} />
				)}
			</div>

			<ProvisionStepper runner={runner} />

			<CurrentJobLine current={current} now={now} />

			<RunnerFaultBanner runner={runner} limit={limit} projectId={projectId} canEdit={canEdit} />

			<PoolReadBanner poolRead={runner.poolRead} />

			<div className="flex items-center justify-between gap-2 text-subtle">
				<span className="fg-caption truncate">
					{runner.repoPath ? <code>{runner.repoPath}</code> : t("runners.row.noRepoPath")}
				</span>
				<span className="fg-caption flex-none">
					{time.relative(runner.lastSeenAt) || t("runners.row.neverSeen")}
				</span>
			</div>

			<RunnerLabels
				projectId={projectId}
				runnerId={runner.runnerId}
				labels={runner.labels ?? []}
				canEdit={canEdit}
			/>

			<PoolAdmission
				projectId={projectId}
				runnerId={runner.runnerId}
				status={runner.runnerStatus}
				canEdit={canEdit}
			/>

			<ResidentMaster
				master={runner.residentMaster}
				slug={slug}
				deviceName={runner.deviceName}
			/>

			<div className="flex justify-start">
				<Button
					variant="ghost"
					size="sm"
					icon={showActivity ? "chevronDown" : "chevronRight"}
					onClick={() => setShowActivity((s) => !s)}
				>
					{showActivity ? t("runners.row.hideActivity") : t("runners.row.activity")}
				</Button>
			</div>
			{showActivity && <RunnerActivityPanel runnerId={runner.runnerId} />}
		</div>
	);
}

/** The device's name, whether it is on, its limit, platform and the runner's own version. */
function RunnerHeading({
	runner,
	limit,
	deviceDisabled,
}: {
	runner: ProjectRunner;
	limit: RunnerLimitDisplay | null;
	deviceDisabled: boolean;
}) {
	const online = runner.deviceStatus === "online" && !deviceDisabled;
	const t = useCopy();
	const language = useInterfaceLanguage();
	return (
		<div className="flex min-w-0 items-center gap-2">
			<HealthDot health={online ? "healthy" : "idle"} withLabel={false} />
			<span className="truncate font-semibold text-fg">
				{runner.deviceName ?? t("runners.row.unknownDevice")}
			</span>
			{deviceDisabled && (
				<Badge tone="neutral">
					<span className="inline-flex items-center gap-1">
						<Icon name="alert" size={11} />
						{t("runners.row.deviceOff")}
					</span>
				</Badge>
			)}
			{limit && (
				<Badge tone={limit.health === "down" ? "red" : "amber"}>
					<span className="inline-flex items-center gap-1">
						<Icon name="alert" size={11} />
						{runnerLimitLine(limit)}
					</span>
				</Badge>
			)}
			{runner.platform && <EnumBadge family="platform" value={runner.platform} />}
			{/* This runner's own version, never Forge's — the two move on
			    different clocks and a reader with one number on screen
			    cannot tell which software a bug belongs to (ISS-1119). */}
			<span className="fg-caption whitespace-nowrap text-muted">
				{runnerVersionLabel(runner.agentVersion, language)}
			</span>
			<HealthDot
				health={provisionHealth(runner.provisionStatus)}
				withLabel={false}
			/>
		</div>
	);
}

/** The job this runner is executing, with its live elapsed time, or Idle. */
function CurrentJobLine({ current, now }: { current: ActiveRunnerJob | null; now: number }) {
	const t = useCopy();
	const language = useInterfaceLanguage();
	if (!current) {
		return (
			<div className="flex items-center gap-2 px-1">
				<HealthDot health="idle" withLabel={false} />
				<span className="fg-body-sm text-subtle">{t("common.health.idle")}</span>
			</div>
		);
	}
	const elapsed = formatElapsed(current.startedAt, language, now);
	return (
		<div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-1.5">
			<HealthDot health="healthy" withLabel={false} />
			<span className="fg-body-sm text-fg">
				{t("runners.row.running")}{" "}
				<span className="font-semibold">{current.issueRef || t("runners.row.aJob")}</span>
				{current.stage && (
					<span className="text-subtle"> · {enumLabel("jobType", current.stage, language)}</span>
				)}
				{current.issueTitle && (
					<span className="text-subtle"> — {current.issueTitle}</span>
				)}
			</span>
			{elapsed && (
				<span className="fg-caption ml-auto flex-none tabular-nums text-subtle">
					{elapsed}
				</span>
			)}
		</div>
	);
}

/** A limit or the last error the runner reported, with the clear-and-retry act for an editor. */
function RunnerFaultBanner({
	runner,
	limit,
	projectId,
	canEdit,
}: {
	runner: ProjectRunner;
	limit: RunnerLimitDisplay | null;
	projectId: string;
	canEdit: boolean;
}) {
	const clearError = useClearRunnerError(projectId);
	const t = useCopy();
	const clearFaultButton = canEdit ? (
		<Button
			variant="secondary"
			size="sm"
			icon="rerun"
			loading={clearError.isPending}
			onClick={() => clearError.mutate(runner.runnerId)}
		>
			{t("runners.row.clearRetry")}
		</Button>
	) : undefined;

	if (limit) {
		return (
			<Banner
				tone={limit.health === "down" ? "danger" : "attention"}
				action={clearFaultButton}
			>
				<span className="font-semibold">
					{limit.reason === "auth"
						? t("runners.row.fixCredentials", { label: limit.label })
						: `${runnerLimitLine(limit)}.`}
				</span>
				{limit.printedText && <> {limit.printedText}</>}
				{limit.detail && (
					<>
						{" "}
						<code className="font-mono text-12">{limit.detail}</code>
					</>
				)}
			</Banner>
		);
	}
	if (!runner.lastError) return null;
	return (
		<Banner tone="attention" action={clearFaultButton}>
			<span className="font-semibold">{t("runners.row.lastError")}</span>{" "}
			<code className="font-mono text-12">{runner.lastError}</code>
		</Banner>
	);
}
