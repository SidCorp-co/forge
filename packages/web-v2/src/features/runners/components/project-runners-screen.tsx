"use client";

// Project-centric Runners screen. Rendered as the Project Settings → Runners
// tab (`/projects/[slug]/settings?tab=runners`, `embedded`). The project is the
// primary control surface: configure the repo URL + deploy key, assign devices,
// and watch each device's workspace provision (clone → skills → mcp) as a live
// stepper. Workspace-level `/runners` is the device-global roll-up (pair /
// rename / revoke); project membership (admin) gates the writes here.

import {
	Badge,
	Banner,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	EmptyState,
	ErrorState,
	Field,
	HealthDot,
	HelpButton,
	Icon,
	Input,
	MonoTag,
	PageContainer,
	Select,
	Skeleton,
	useNow,
} from "@/design";
import { useUpdateProject } from "@/features/project-settings/hooks";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useMemo, useState } from "react";
import {
	useActiveRunners,
	useAssignDeviceToProject,
	useDeleteGitCredential,
	useDevices,
	useGitCredential,
	useInitPairing,
	useProjectRunners,
	useReprovision,
	useRunnerActivity,
	useSetDefaultDevice,
	useSetDeviceDisabled,
	useSetGitCredential,
	useTestGitCredential,
	useUnassignDeviceFromProject,
} from "../hooks";
import {
	type ActiveRunnerJob,
	PROVISION_LABEL,
	PROVISION_STEPS,
	type ProjectRunner,
	type ProvisionStatus,
	formatElapsed,
	provisionHealth,
	runnerLimitDisplay,
} from "../types";

function CopyButton({
	value,
	label = "Copy",
}: { value: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			icon={copied ? "check" : "link"}
			onClick={() => {
				void navigator.clipboard?.writeText(value).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? "Copied" : label}
		</Button>
	);
}

/** Repo URL + deploy-key card. Both optional — absent => manual folder setup. */
function GitConfigCard({
	projectId,
	repoUrl,
	canEdit,
}: {
	projectId: string;
	repoUrl: string | null;
	canEdit: boolean;
}) {
	const update = useUpdateProject(projectId);
	const cred = useGitCredential(projectId);
	const setCred = useSetGitCredential(projectId);
	const delCred = useDeleteGitCredential(projectId);
	const testCred = useTestGitCredential(projectId);
	const [url, setUrl] = useState(repoUrl ?? "");
	const [paste, setPaste] = useState("");
	const [showPaste, setShowPaste] = useState(false);

	const urlDirty = url.trim() !== (repoUrl ?? "");
	const credData = cred.data;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Git access</CardTitle>
				<HelpButton
					summary="Optional. Set the repo URL + a deploy key so any device assigned to this project auto-clones and pushes — add the key once, scale to every runner. Leave blank to set folders up by hand."
					actions={[
						"Set the SSH clone URL (git@host:org/repo.git)",
						"Generate a deploy key, then add the public key to your repo's deploy keys",
						"Or paste an existing private key",
					]}
				/>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-5">
					<div className="flex items-end gap-2">
						<div className="flex-1">
							<Field
								label="Repo URL"
								hint="SSH clone URL. A newly-assigned device clones from here when its folder is missing."
							>
								<Input
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									placeholder="git@github.com:org/repo.git"
									disabled={!canEdit}
									spellCheck={false}
									maxLength={500}
								/>
							</Field>
						</div>
						<Button
							variant="secondary"
							icon="check"
							loading={update.isPending}
							disabled={!canEdit || !urlDirty}
							onClick={() => update.mutate({ repoUrl: url.trim() || null })}
						>
							Save
						</Button>
					</div>

					<div className="border-t border-line-subtle pt-4">
						<span className="fg-label">Deploy key</span>
						{cred.isLoading ? (
							<Skeleton className="mt-2 h-20 w-full" />
						) : credData?.configured ? (
							<div className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-sunken p-3">
								<div className="flex items-center justify-between gap-2">
									<span className="inline-flex items-center gap-1.5 text-[13px] text-fg">
										<Icon
											name="check"
											size={14}
											className="text-[color:var(--green-600)]"
										/>
										{credData.source === "forge_generated"
											? "Forge-generated"
											: "User-provided"}{" "}
										key
									</span>
									{credData.fingerprint && (
										<MonoTag>{credData.fingerprint}</MonoTag>
									)}
								</div>
								<div className="flex items-center justify-between gap-2">
									<code className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle">
										{credData.publicKey}
									</code>
									<CopyButton
										value={credData.publicKey}
										label="Copy public key"
									/>
								</div>
								<p className="fg-body-sm text-subtle">
									Add this public key to your repo&apos;s deploy keys (write
									access) so runners can clone + push.
								</p>
								{testCred.data && (
									<Banner tone={testCred.data.ok ? "success" : "danger"}>
										{testCred.data.message}
										{testCred.data.headSha
											? ` (HEAD ${testCred.data.headSha.slice(0, 10)})`
											: ""}
									</Banner>
								)}
								<div className="flex items-center justify-between gap-2">
									<Button
										variant="secondary"
										size="sm"
										icon="activity"
										loading={testCred.isPending}
										onClick={() => testCred.mutate()}
									>
										Test connection
									</Button>
									{canEdit && (
										<Button
											variant="ghost"
											size="sm"
											icon="trash"
											loading={delCred.isPending}
											onClick={() => delCred.mutate()}
										>
											Remove key
										</Button>
									)}
								</div>
							</div>
						) : (
							<div className="mt-2 flex flex-col gap-3">
								<p className="fg-body-sm text-subtle">
									No deploy key. Generate one (recommended) or paste an existing
									private key. Without a key, devices use whatever git auth they
									already have.
								</p>
								{canEdit && (
									<div className="flex flex-wrap items-center gap-2">
										<Button
											variant="primary"
											size="sm"
											icon="plus"
											loading={setCred.isPending}
											onClick={() => setCred.mutate({ mode: "generate" })}
										>
											Generate keypair
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setShowPaste((s) => !s)}
										>
											Paste existing key
										</Button>
									</div>
								)}
								{showPaste && canEdit && (
									<div className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong p-3">
										<textarea
											value={paste}
											onChange={(e) => setPaste(e.target.value)}
											placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
											spellCheck={false}
											rows={5}
											className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12px] text-fg"
										/>
										<div className="flex justify-end">
											<Button
												variant="primary"
												size="sm"
												loading={setCred.isPending}
												disabled={paste.trim().length === 0}
												onClick={() =>
													setCred.mutate(
														{ mode: "provide", privateKey: paste },
														{
															onSuccess: () => {
																setPaste("");
																setShowPaste(false);
															},
														},
													)
												}
											>
												Save key
											</Button>
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

/** Horizontal step row reflecting one runner's provision lifecycle. */
function ProvisionStepper({ runner }: { runner: ProjectRunner }) {
	const status = runner.provisionStatus;
	if (!status) {
		return <span className="fg-body-sm text-subtle">Not provisioned</span>;
	}
	if (status === "needs_manual_setup" || status === "failed") {
		return (
			<Banner tone={status === "failed" ? "attention" : "info"}>
				<span className="font-semibold">{PROVISION_LABEL[status]}.</span>{" "}
				{runner.provisionDetail ?? "See the device logs for details."}
			</Banner>
		);
	}
	const activeIdx = PROVISION_STEPS.indexOf(status);
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{PROVISION_STEPS.map((step, i) => {
				const done = i < activeIdx || status === "ready";
				const active = i === activeIdx && status !== "ready";
				return (
					<span key={step} className="inline-flex items-center gap-1.5">
						<HealthDot
							health={done ? "healthy" : active ? "idle" : "idle"}
							withLabel={false}
						/>
						<span
							className={
								done
									? "fg-caption text-fg"
									: active
										? "fg-caption font-semibold text-accent"
										: "fg-caption text-subtle"
							}
						>
							{PROVISION_LABEL[step]}
						</span>
						{i < PROVISION_STEPS.length - 1 && (
							<Icon name="arrowRight" size={11} className="text-subtle" />
						)}
					</span>
				);
			})}
		</div>
	);
}

/** Lazy-loaded activity feed for one runner: status timeline + recent sessions. */
function RunnerActivityPanel({ runnerId }: { runnerId: string }) {
	const activity = useRunnerActivity(runnerId, true);

	if (activity.isLoading) {
		return <Skeleton className="h-24 w-full" />;
	}
	if (activity.isError) {
		return (
			<ErrorState
				message={formatApiError(activity.error)}
				onRetry={() => activity.refetch()}
			/>
		);
	}
	const events = activity.data?.events ?? [];
	const sessions = activity.data?.sessions ?? [];
	if (events.length === 0 && sessions.length === 0) {
		return (
			<p className="fg-body-sm text-subtle">No recorded activity yet.</p>
		);
	}

	return (
		<div className="flex flex-col gap-4 rounded-lg border border-line bg-sunken p-3">
			{sessions.length > 0 && (
				<div className="flex flex-col gap-2">
					<span className="fg-label">Recent sessions on this device</span>
					{sessions.map((s) => (
						<div
							key={s.id}
							className="flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-[13px] text-fg">
									{s.title ?? "Untitled session"}
								</span>
								<span className="fg-caption flex-none text-subtle">
									{formatRelativeTime(s.updatedAt)}
								</span>
							</div>
							<div className="flex items-center gap-1.5">
								<Badge
									tone={
										s.status === "failed"
											? "red"
											: s.status === "completed"
												? "green"
												: "neutral"
									}
								>
									{s.status}
								</Badge>
								{s.failureReason && (
									<MonoTag>{s.failureReason}</MonoTag>
								)}
							</div>
							{s.errorExcerpt && (
								<code className="whitespace-pre-wrap break-words font-mono text-[11px] text-[color:var(--red-600)]">
									{s.errorExcerpt}
								</code>
							)}
						</div>
					))}
				</div>
			)}

			{events.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<span className="fg-label">Status history</span>
					{events.map((e) => (
						<div
							key={e.id}
							className="flex items-center justify-between gap-2 text-[12px]"
						>
							<span className="text-fg">
								{e.oldStatus ? `${e.oldStatus} → ` : ""}
								<span className="font-semibold">{e.newStatus}</span>
								{e.reason && (
									<span className="text-subtle"> · {e.reason}</span>
								)}
							</span>
							<span className="fg-caption flex-none text-subtle">
								{formatRelativeTime(e.ts)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** One assigned device row + its provision stepper + actions. */
function RunnerRow({
	runner,
	current,
	projectId,
	canEdit,
	isPrimary,
	onSetPrimary,
	settingPrimary,
}: {
	runner: ProjectRunner;
	/** The job this runner is executing right now, or null when idle. */
	current: ActiveRunnerJob | null;
	projectId: string;
	canEdit: boolean;
	/** True when this device is the project's primary (defaultDeviceId). */
	isPrimary: boolean;
	/** Set this device as primary (deviceId), or clear (null). */
	onSetPrimary: (deviceId: string | null) => void;
	settingPrimary: boolean;
}) {
	const reprovision = useReprovision(projectId);
	const unassign = useUnassignDeviceFromProject(projectId);
	const setDisabled = useSetDeviceDisabled();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [showActivity, setShowActivity] = useState(false);
	// A disabled device's runner keeps heartbeating (deviceStatus stays
	// "online"), so `deviceDisabledAt` is the real reason it receives no jobs —
	// the dispatcher excludes disabled devices. Surface it explicitly instead of
	// showing a misleading healthy dot.
	const deviceDisabled = Boolean(runner.deviceDisabledAt);
	const online = runner.deviceStatus === "online" && !deviceDisabled;
	// Tick once a second while this runner is limited (live reset countdown) OR
	// busy (live elapsed counter on the current job).
	const now = useNow(1000, Boolean(runner.limitReason) || Boolean(current));
	const limit = runnerLimitDisplay(runner, now);
	const elapsed = current ? formatElapsed(current.startedAt, now) : null;

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<HealthDot health={online ? "healthy" : "idle"} withLabel={false} />
					<span className="truncate font-semibold text-fg">
						{runner.deviceName ?? "Unknown device"}
					</span>
					{deviceDisabled && (
						<Badge tone="neutral">
							<span className="inline-flex items-center gap-1">
								<Icon name="alert" size={11} />
								Device off
							</span>
						</Badge>
					)}
					{limit && (
						<Badge tone={limit.health === "down" ? "red" : "amber"}>
							<span className="inline-flex items-center gap-1">
								<Icon name="alert" size={11} />
								{limit.label}
								{limit.active && limit.resetText ? ` · ${limit.resetText}` : ""}
							</span>
						</Badge>
					)}
					{isPrimary && (
						<Badge tone="accent">
							<span className="inline-flex items-center gap-1">
								<Icon name="star" size={11} />
								Primary
							</span>
						</Badge>
					)}
					{runner.platform && <MonoTag>{runner.platform}</MonoTag>}
					<HealthDot
						health={provisionHealth(runner.provisionStatus)}
						withLabel={false}
					/>
				</div>
				{canEdit &&
					(confirmRemove ? (
						<span className="inline-flex items-center gap-1.5">
							<Button
								variant="danger"
								size="sm"
								icon="trash"
								loading={unassign.isPending}
								onClick={() =>
									unassign.mutate(runner.runnerId, {
										onSettled: () => setConfirmRemove(false),
									})
								}
							>
								Remove
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setConfirmRemove(false)}
							>
								Cancel
							</Button>
						</span>
					) : (
						<span className="inline-flex items-center gap-1">
							{runner.deviceId && deviceDisabled && (
								<Button
									variant="secondary"
									size="sm"
									icon="play"
									loading={setDisabled.isPending}
									onClick={() =>
										setDisabled.mutate({
											id: runner.deviceId as string,
											disabled: false,
										})
									}
								>
									Turn on
								</Button>
							)}
							{runner.deviceId &&
								(isPrimary ? (
									<Button
										variant="ghost"
										size="sm"
										icon="star"
										loading={settingPrimary}
										onClick={() => onSetPrimary(null)}
									>
										Unset primary
									</Button>
								) : (
									<Button
										variant="ghost"
										size="sm"
										icon="star"
										loading={settingPrimary}
										onClick={() => onSetPrimary(runner.deviceId as string)}
									>
										Set primary
									</Button>
								))}
							{runner.deviceId && (
								<Button
									variant="ghost"
									size="sm"
									icon="rerun"
									loading={reprovision.isPending}
									onClick={() =>
										reprovision.mutate({
											deviceId: runner.deviceId as string,
											repoPath: runner.repoPath,
										})
									}
								>
									Re-provision
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								icon="trash"
								onClick={() => setConfirmRemove(true)}
							>
								Unassign
							</Button>
						</span>
					))}
			</div>

			<ProvisionStepper runner={runner} />

			{current ? (
				<div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-1.5">
					<HealthDot health="healthy" withLabel={false} />
					<span className="fg-body-sm text-fg">
						Running{" "}
						{current.issueRef ? (
							<span className="font-semibold">{current.issueRef}</span>
						) : (
							<span className="font-semibold">a job</span>
						)}
						{current.stage && (
							<span className="text-subtle"> · {current.stage}</span>
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
			) : (
				<div className="flex items-center gap-2 px-1">
					<HealthDot health="idle" withLabel={false} />
					<span className="fg-body-sm text-subtle">Idle</span>
				</div>
			)}

			{limit ? (
				<Banner tone={limit.health === "down" ? "danger" : "attention"}>
					<span className="font-semibold">
						{limit.label}
						{limit.reason === "auth"
							? " — fix the runner's credentials."
							: limit.active && limit.resetText
								? ` — ${limit.resetText}.`
								: " — recently throttled."}
					</span>
					{limit.detail && (
						<>
							{" "}
							<code className="font-mono text-[12px]">{limit.detail}</code>
						</>
					)}
				</Banner>
			) : (
				runner.lastError && (
					<Banner tone="attention">
						<span className="font-semibold">Last error.</span>{" "}
						<code className="font-mono text-[12px]">{runner.lastError}</code>
					</Banner>
				)
			)}

			<div className="flex items-center justify-between gap-2 text-subtle">
				<span className="fg-caption truncate">
					{runner.repoPath ? (
						<code>{runner.repoPath}</code>
					) : (
						"no repo path set"
					)}
				</span>
				<span className="fg-caption flex-none">
					{formatRelativeTime(runner.lastSeenAt, { emptyLabel: "never seen" })}
				</span>
			</div>

			<div className="flex justify-start">
				<Button
					variant="ghost"
					size="sm"
					icon={showActivity ? "chevronDown" : "chevronRight"}
					onClick={() => setShowActivity((s) => !s)}
				>
					{showActivity ? "Hide activity" : "Activity & logs"}
				</Button>
			</div>
			{showActivity && <RunnerActivityPanel runnerId={runner.runnerId} />}
		</div>
	);
}

/** Assign an already-paired device, or pair one inline (it then appears here). */
function AssignDevice({
	projectId,
	defaultRepoPath,
	assignedDeviceIds,
}: {
	projectId: string;
	defaultRepoPath: string | null;
	assignedDeviceIds: Set<string>;
}) {
	const devices = useDevices();
	const assign = useAssignDeviceToProject(projectId);
	const initPairing = useInitPairing();
	const [deviceId, setDeviceId] = useState("");
	const [repoPath, setRepoPath] = useState(defaultRepoPath ?? "");

	const available = useMemo(
		() =>
			(devices.data ?? []).filter(
				(d) => d.status !== "revoked" && !assignedDeviceIds.has(d.id),
			),
		[devices.data, assignedDeviceIds],
	);

	const options = [
		{ value: "", label: "Select a paired device…" },
		...available.map((d) => ({
			value: d.id,
			label: `${d.name} (${d.platform})`,
		})),
	];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Add a device</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex flex-col gap-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label="Device">
							<Select
								options={options}
								value={deviceId}
								onChange={setDeviceId}
							/>
						</Field>
						<Field
							label="Repo path"
							hint="Absolute path on that device — typed manually."
						>
							<Input
								value={repoPath}
								onChange={(e) => setRepoPath(e.target.value)}
								placeholder={defaultRepoPath ?? "/abs/path/on/the/device"}
								spellCheck={false}
							/>
						</Field>
					</div>
					<div className="flex justify-end">
						<Button
							variant="primary"
							icon="plus"
							loading={assign.isPending}
							disabled={!deviceId}
							onClick={() =>
								assign.mutate(
									{ deviceId, repoPath: repoPath.trim() || null },
									{ onSuccess: () => setDeviceId("") },
								)
							}
						>
							Assign &amp; provision
						</Button>
					</div>

					<div className="rounded-lg border border-dashed border-line-strong p-3">
						<span className="fg-label">No device yet? Pair one</span>
						<div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
							<code className="font-mono text-[13px] text-fg">
								forge-runner login
							</code>
							<CopyButton value="forge-runner login" />
						</div>
						<p className="fg-body-sm mt-1.5 text-subtle">
							Run it on the device, approve in the browser — it appears in the
							picker above, then assign it here. Or{" "}
							<button
								type="button"
								className="text-accent hover:underline"
								onClick={() => initPairing.mutate("forge-runner")}
							>
								generate a pairing code
							</button>
							{initPairing.data && (
								<>
									{" "}
									— code{" "}
									<span className="font-mono font-semibold">
										{initPairing.data.pairing_code}
									</span>
									, approve at{" "}
									<a
										href={initPairing.data.verify_url}
										className="text-accent hover:underline"
									>
										{initPairing.data.verify_url}
									</a>
								</>
							)}
							.
						</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function ProjectRunnersScreen({
	projectId,
	canEdit,
	embedded = false,
}: {
	projectId: string;
	canEdit: boolean;
	/** True when rendered inside the Project Settings "Runners" tab — the tab
	 * strip already supplies page chrome, so skip PageContainer + the header. */
	embedded?: boolean;
}) {
	useRoom(projectRoom(projectId));
	const project = useProject(projectId);
	const runners = useProjectRunners(projectId);
	const active = useActiveRunners(projectId);
	const setDefault = useSetDefaultDevice(projectId);
	const defaultDeviceId = project.data?.defaultDeviceId ?? null;

	const rows = runners.data ?? [];
	const assignedDeviceIds = useMemo(
		() =>
			new Set(rows.map((r) => r.deviceId).filter((id): id is string => !!id)),
		[rows],
	);
	// runnerId → its current in-flight job, for the per-row "running …" line.
	const currentByRunner = useMemo(
		() =>
			new Map(
				(active.data?.runners ?? []).map((r) => [r.runnerId, r.current]),
			),
		[active.data],
	);

	const body = (
		<>
			{!embedded && (
				<div className="flex items-center justify-between gap-3">
					<div>
						<h1 className="fg-h2">Runners</h1>
						<p className="fg-body-sm text-muted">
							Devices that run this project&apos;s pipeline jobs. Status &amp;
							provisioning update live.
						</p>
					</div>
					<HelpButton
						summary="Assign paired devices to this project. Each gets its own checkout; with a repo URL + deploy key, a freshly-assigned device auto-clones, syncs skills, and writes its MCP config."
						actions={[
							"Set Git access (repo URL + deploy key) for hands-off provisioning",
							"Assign a device — watch it clone → sync skills → ready",
							"Manage devices account-wide on the Runners page",
						]}
					/>
				</div>
			)}

			<GitConfigCard
				projectId={projectId}
				repoUrl={project.data?.repoUrl ?? null}
				canEdit={!!canEdit}
			/>

			{canEdit && (
				<AssignDevice
					projectId={projectId}
					defaultRepoPath={project.data?.repoPath ?? null}
					assignedDeviceIds={assignedDeviceIds}
				/>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Assigned devices</CardTitle>
				</CardHeader>
				<CardContent>
					{runners.isLoading ? (
						<div className="flex flex-col gap-2">
							<Skeleton className="h-28 w-full" />
							<Skeleton className="h-28 w-full" />
						</div>
					) : runners.isError ? (
						<ErrorState
							message={formatApiError(runners.error)}
							onRetry={() => runners.refetch()}
						/>
					) : rows.length === 0 ? (
						<EmptyState
							title="No devices assigned"
							message="Assign a paired device above to start running this project's jobs."
							mascot={false}
						/>
					) : (
						<div className="flex flex-col gap-3">
							{rows.map((r) => (
								<RunnerRow
									key={r.runnerId}
									runner={r}
									current={currentByRunner.get(r.runnerId) ?? null}
									projectId={projectId}
									canEdit={!!canEdit}
									isPrimary={!!r.deviceId && r.deviceId === defaultDeviceId}
									onSetPrimary={(id) => setDefault.mutate(id)}
									settingPrimary={setDefault.isPending}
								/>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</>
	);

	if (embedded) {
		return <div className="flex flex-col gap-5">{body}</div>;
	}
	return <PageContainer className="flex flex-col gap-5">{body}</PageContainer>;
}
