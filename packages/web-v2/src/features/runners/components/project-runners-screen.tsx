"use client";

// Project-centric Runners screen. Rendered as the Project Settings → Runners
// tab (`/projects/[slug]/settings?tab=connections#runners`, `embedded`). The project is the
// primary control surface: assign devices,
// and watch each device's workspace provision (clone → skills → mcp) as a live
// stepper. Workspace-level `/runners` is the device-global roll-up (pair /
// rename / revoke); project membership (admin) gates the writes here.

import {
	Banner,
	Button,
	PageSection,
	PageSectionBody,
	PageSectionHeader,
	PageSectionTitle,
	EmptyState,
	ErrorState,
	Field,
	HelpButton,
	Input,
	PageContainer,
	PageTitle,
	Select,
	Skeleton,
	enumLabel,
} from "@/design";
import { useProjectDocument } from "@/features/project-config/hooks";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useMemo, useState } from "react";
import { CopyButton } from "./runners-screen";
import { RunnerRow } from "./runner-row/runner-row";
import {
	useActiveRunners,
	useAssignDeviceToProject,
	useDevices,
	useProjectRunners,
} from "../hooks";
import { TopBarActions } from "@/design/primitives/top-bar-slot";

function repositoryOf(document: Record<string, unknown> | null | undefined): string | null {
	const source = document?.source as { type?: unknown; git?: { repository?: unknown } } | undefined;
	return source?.type === "git" && typeof source.git?.repository === "string"
		? source.git.repository
		: null;
}

/** Assign an already-paired device, or pair one inline (it then appears here). */
function AssignDevice({
	projectId,
	assignedDeviceIds,
	hasRepository,
}: {
	projectId: string;
	assignedDeviceIds: Set<string>;
	hasRepository: boolean;
}) {
	const devices = useDevices();
	const assign = useAssignDeviceToProject(projectId);
	const [deviceId, setDeviceId] = useState("");
	const [repoPath, setRepoPath] = useState("");
	const t = useCopy();
	const language = useInterfaceLanguage();

	const available = useMemo(
		() =>
			(devices.data ?? []).filter(
				(d) => d.status !== "revoked" && !assignedDeviceIds.has(d.id),
			),
		[devices.data, assignedDeviceIds],
	);

	const options = [
		{ value: "", label: t("runners.assign.select") },
		...available.map((d) => ({
			value: d.id,
			// Online-ness decides whether provisioning starts now or on the
			// device's next reconnect, so it belongs in the choice, not after it.
			label: `${d.name} (${enumLabel("platform", d.platform, language)}) — ${d.status === "online" ? t("runners.assign.online") : t("runners.assign.offline")}`,
		})),
	];
	const picked = available.find((d) => d.id === deviceId) ?? null;

	return (
		<PageSection>
			<PageSectionHeader>
				<PageSectionTitle>{t("runners.assign.title")}</PageSectionTitle>
			</PageSectionHeader>
			<PageSectionBody>
				<div className="flex flex-col gap-4">
					<div className="grid gap-3 sm:grid-cols-2">
						<Field label={t("runners.col.device")}>
							<Select
								options={options}
								value={deviceId}
								onChange={setDeviceId}
							/>
						</Field>
						<Field
							label={t("runners.assign.repoPath")}
							hint={t("runners.assign.repoPathHint")}
						>
							<Input
								value={repoPath}
								onChange={(e) => setRepoPath(e.target.value)}
								placeholder="/abs/path/on/the/device"
								spellCheck={false}
							/>
						</Field>
					</div>

					{/* Both conditions are decided elsewhere (the card above, and
					    the device itself), and both change what "Assign &
					    provision" actually does. */}
					{!hasRepository && (
						<Banner tone="info">{t("runners.assign.noRepository")}</Banner>
					)}
					{picked && picked.status !== "online" && (
						<Banner tone="info">{t("runners.assign.offlineNote", { name: picked.name })}</Banner>
					)}

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
							{t("runners.assign.submit")}
						</Button>
					</div>

					<div className="rounded-lg border border-dashed border-line-strong p-3">
						<span className="fg-label">{t("runners.assign.noDevice")}</span>
						<div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2">
							<code className="font-mono text-13 text-fg">
								forge-runner setup
							</code>
							<CopyButton value="forge-runner setup" />
						</div>
						<p className="fg-body-sm mt-1.5 text-subtle">{t("runners.assign.setupBody")}</p>
					</div>
				</div>
			</PageSectionBody>
		</PageSection>
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
	const projectDocument = useProjectDocument(projectId);
	const repository = repositoryOf(projectDocument.data?.document);
	const runners = useProjectRunners(projectId);
	const active = useActiveRunners(projectId);
	const t = useCopy();

	const rows = runners.data ?? [];
	const assignedDeviceIds = useMemo(
		() =>
			new Set(rows.map((r) => r.deviceId).filter((id): id is string => !!id)),
		[rows],
	);
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
				<>
					<PageTitle hint={t("runners.project.hint")}>{t("overview.runners.title")}</PageTitle>
					<TopBarActions>
					<HelpButton
						summary={t("runners.project.help")}
						actions={[t("runners.project.helpDeclare"), t("runners.project.helpAssign"), t("runners.project.helpManage")]}
					/>
					</TopBarActions>
				</>
			)}

			{canEdit && (
				<AssignDevice
					projectId={projectId}
					assignedDeviceIds={assignedDeviceIds}
					hasRepository={repository !== null}
				/>
			)}

			<PageSection>
				<PageSectionHeader>
					<PageSectionTitle>{t("runners.project.assigned")}</PageSectionTitle>
				</PageSectionHeader>
				<PageSectionBody>
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
							title={t("runners.project.noneAssigned")}
							message={t("runners.project.noneAssignedBody")}
							mascot={false}
						/>
					) : (
						<div className="flex flex-col divide-y divide-line-subtle">
							{rows.map((r) => (
								<RunnerRow
									key={r.runnerId}
									runner={r}
									current={currentByRunner.get(r.runnerId) ?? null}
									projectId={projectId}
									canEdit={!!canEdit}
									slug={project.data?.slug}
								/>
							))}
						</div>
					)}
				</PageSectionBody>
			</PageSection>
		</>
	);

	if (embedded) {
		return <div className="flex flex-col gap-5">{body}</div>;
	}
	return <PageContainer className="flex flex-col gap-5">{body}</PageContainer>;
}
