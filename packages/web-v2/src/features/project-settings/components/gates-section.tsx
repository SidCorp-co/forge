// Settings → Gates (REQ-76 BC-12): how tightly Forge gates this project's agents. A person decides one
// thing here, the profile; the policy gates under it are listed by name with the mode each takes in
// this project, and the kernel no profile relaxes below them. No gate has a switch of its own: routine
// approval is a defect (owner, 2026-11-06, ISS-1071), so the per-gate overrides a project already holds
// are kept as stored and written back unchanged with the profile. A change is one write at the revision
// read, with the reason it is kept under, through the gates' own door (`PUT .../gates`); what core
// refuses is shown as it wrote it. The changes list below is that door's record. That door asks
// project.admin, which an org owner or admin holds and so does the project's own admin, so unlike the
// document sections (org admins only) a project admin sets the profile here too.
import type { GateMode, GateProfile, ResolvedGate } from "@forge/contracts/gate-profiles";
import { useId, useState } from "react";
import { Banner, Button, EnumBadge, ErrorState, FormActions, Input, Radio, RadioGroup, RowItem, RowList, SettingRow, SettingsGroup, Skeleton } from "@/design";
import { canManageProject, isOrgAdmin, type ProjectListItem } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useGateCatalog, useProjectGates, useWriteGates } from "../hooks";
import type { GateCatalog, GateChange, ProjectGates } from "../types";
import { UndeclaredNotice } from "./general-section";

type Copy = ReturnType<typeof useCopy>;
type Overrides = Partial<Record<string, GateMode>>;

const PROFILES: readonly GateProfile[] = ["strict", "standard", "yolo"];

const modeLabel = (t: Copy, mode: GateMode) => t(`settings.project.gates.mode.${mode}`);

/** Whether a reader holds project.admin here, the permission `PUT /projects/:id/gates` asks. */
export const canSetGates = ({ orgRole, role }: Pick<ProjectListItem, "orgRole" | "role">) => isOrgAdmin(orgRole) || canManageProject(role);

export function GatesSettings({ projectId, slug, access }: { projectId: string; slug: string; access: Pick<ProjectListItem, "orgRole" | "role"> }) {
	const canEdit = canSetGates(access);
	const catalogQ = useGateCatalog();
	const gatesQ = useProjectGates(projectId);
	if (catalogQ.isError) return <ErrorState message={formatApiError(catalogQ.error)} onRetry={() => void catalogQ.refetch()} />;
	if (gatesQ.isError) return <ErrorState message={formatApiError(gatesQ.error)} onRetry={() => void gatesQ.refetch()} />;
	if (!catalogQ.data || !gatesQ.data) return <Skeleton className="h-64 w-full rounded-md" />;
	// keyed on the revision read, so a saved write (or one made elsewhere) starts the form again from what core holds
	return <GatesForm key={gatesQ.data.revision ?? 0} projectId={projectId} slug={slug} canEdit={canEdit} catalog={catalogQ.data} view={gatesQ.data} />;
}

function GatesForm({ projectId, slug, canEdit, catalog, view }: { projectId: string; slug: string; canEdit: boolean; catalog: GateCatalog; view: ProjectGates }) {
	const t = useCopy();
	const reasonId = useId();
	const write = useWriteGates(projectId);
	const [profile, setProfile] = useState<GateProfile>(view.profile);
	const [reason, setReason] = useState("");
	const off = !canEdit || !view.declared;
	const dirty = profile !== view.profile;
	const resolved = new Map(view.gates.map((g) => [g.id, g]));
	const titles = new Map(catalog.gates.map((g) => [g.id, g.title]));

	// the overrides go back as core holds them: no control here sets one
	const save = () => {
		if (view.revision === null) return;
		write.mutate({ baseRevision: view.revision, profile, overrides: view.overrides, reason: reason.trim() });
	};

	return (
		<div data-testid="gates-section">
			{!view.declared && <UndeclaredNotice slug={slug} />}
			{view.raised && <RaisedBanner raised={view.raised} to={view.profile} />}
			<SettingsGroup id="profile" title={t("settings.project.gates.profile")} summary={t("settings.project.gates.kernelHolds")}>
				<RadioGroup name="gate-profile" value={profile} onChange={(v) => !off && setProfile(v as GateProfile)}>
					{PROFILES.map((p) => (
						<Radio
							key={p}
							value={p}
							disabled={off}
							label={
								<>
									<span className="font-semibold">{t(`settings.project.gates.profile.${p}`)}</span>
									<span className="text-muted"> · {t(`settings.project.gates.profile.${p}.means`)}</span>
								</>
							}
						/>
					))}
				</RadioGroup>
			</SettingsGroup>
			<SettingsGroup id="gates" title={t("settings.project.gates.title")}>
				<RowList label={t("settings.project.gates.title")} testId="gates-list">
					{catalog.gates.map((g) => {
						const now = resolved.get(g.id as ResolvedGate["id"]);
						return <RowItem key={g.id} testId={`gate-${g.id}`} title={g.title} tip={g.refuses} trailing={now ? <EnumBadge family="gateMode" value={now.mode} /> : null} />;
					})}
				</RowList>
			</SettingsGroup>
			<SettingsGroup id="kernel" title={t("settings.project.gates.kernel")} summary={t("settings.project.gates.kernelAlways")}>
				<ul className="divide-y divide-line-subtle border-y border-line-subtle" data-testid="gates-kernel">
					{catalog.kernel.map((k) => (
						<li key={k.id} className="fg-body-sm py-2 text-fg">
							{k.holds}
						</li>
					))}
				</ul>
			</SettingsGroup>
			{canEdit && view.declared && (
				<FormActions>
					<div className="min-w-0 flex-1">
						<SettingRow
							label={t("settings.project.gates.reason")}
							htmlFor={reasonId}
							control={
								<Input
									id={reasonId}
									aria-label={t("settings.project.gates.reason")}
									value={reason}
									maxLength={500}
									required
									placeholder={t("settings.project.gates.reasonPlaceholder")}
									onChange={(e) => setReason(e.target.value)}
								/>
							}
						/>
					</div>
					<Button variant="primary" className="min-h-11 self-end" disabled={!dirty || reason.trim() === ""} loading={write.isPending} onClick={save}>
						{t("settings.project.save.save")}
					</Button>
					{write.isError && (
						<ul className="fg-caption w-full space-y-0.5 text-danger-11" role="alert" data-testid="gates-refused">
							{refusalsOf(write.error).map((r) => (
								<li key={`${r.code}:${r.path}`}>
									<code translate="no">{r.code}</code>
									{r.path ? (
										<>
											{" "}
											<code translate="no">{r.path}</code>
										</>
									) : null}
									: {r.detail}
								</li>
							))}
						</ul>
					)}
				</FormActions>
			)}
			<SettingsGroup id="changes" title={t("settings.project.gates.changes")}>
				<ChangesList changes={view.changes} titles={titles} />
			</SettingsGroup>
		</div>
	);
}

function RaisedBanner({ raised, to }: { raised: NonNullable<ProjectGates["raised"]>; to: GateProfile }) {
	const t = useCopy();
	const time = useTimeFormat();
	return (
		<div className="mb-6" data-testid="gates-raised">
			<Banner tone="attention">
				{t("settings.project.gates.raised", {
					from: t(`settings.project.gates.profile.${raised.from}`),
					to: t(`settings.project.gates.profile.${to}`),
					cause: t(`settings.project.gates.cause.${raised.cause}`),
					ref: raised.ref,
					at: time.dateTime(raised.at),
				})}{" "}
				{t("settings.project.gates.raisedLower")}
			</Banner>
		</div>
	);
}

/** "Gate a → b" for each override the change set, moved or removed, each gate by its name; "profile" where none was held. */
function overridesMoved(t: Copy, from: Overrides, to: Overrides, titles: Map<string, string>): string[] {
	const ids = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((id) => from[id] !== to[id]);
	const side = (m: GateMode | undefined) => (m ? modeLabel(t, m) : t("settings.project.gates.profileDefault"));
	return ids.map((id) => `${titles.get(id) ?? id} ${side(from[id])} → ${side(to[id])}`);
}

function ChangesList({ changes, titles }: { changes: GateChange[]; titles: Map<string, string> }) {
	const t = useCopy();
	const time = useTimeFormat();
	if (changes.length === 0) return <p className="fg-body-sm text-muted">{t("settings.project.gates.changesNone")}</p>;
	return (
		<RowList label={t("settings.project.gates.changes")} testId="gates-changes">
			{changes.map((c) => {
				const who = c.actorName ?? (c.actorKind === "forge" ? t("settings.project.gates.forge") : null);
				const moved = overridesMoved(t, c.overridesFrom ?? {}, c.overridesTo ?? {}, titles);
				const raised = c.cause !== "set" ? t("settings.project.gates.raisedAfter", { cause: t(`settings.project.gates.cause.${c.cause}`) }) : null;
				return (
					<RowItem
						key={`${c.at}:${c.configRevision}`}
						wrap
						title={`${c.profileFrom ? t(`settings.project.gates.profile.${c.profileFrom}`) : "—"} → ${t(`settings.project.gates.profile.${c.profileTo}`)}`}
						facts={[time.dateTime(c.at), ...(who ? [who] : []), ...(raised ? [raised] : [])]}
						note={[c.reason, ...moved].join(" · ")}
					/>
				);
			})}
		</RowList>
	);
}
