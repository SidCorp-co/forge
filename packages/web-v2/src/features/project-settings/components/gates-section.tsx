// Settings → Gates (REQ-76 BC-12): how tightly Forge gates this project's agents. One profile, a
// mode per policy gate on top of it, and the kernel no profile relaxes. The catalog (`GET /api/gates`)
// says what each gate refuses and its default per profile; the project's read says the mode each gate
// takes here and where that came from. A change is one write of the whole profile and overrides at the
// revision read, with the reason it is kept under, through the gates' own door (`PUT .../gates`);
// what core refuses is shown as it wrote it. The changes table below is that door's record. That door
// asks project.admin, which an org owner or admin holds and so does the project's own admin, so unlike
// the document sections (org admins only) a project admin sets the gates here too.
import type { GateDefault, GateEntry, GateMode, GateProfile, ResolvedGate } from "@forge/contracts/gate-profiles";
import { useId, useState } from "react";
import { Banner, Button, ErrorState, FormActions, Input, Radio, RadioGroup, SettingRow, SettingsGroup, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { canManageProject, isOrgAdmin, type ProjectListItem } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useGateCatalog, useProjectGates, useWriteGates } from "../hooks";
import type { GateCatalog, GateChange, ProjectGates } from "../types";
import { UndeclaredNotice } from "./general-section";
import { Picker } from "./setting-controls";

type Copy = ReturnType<typeof useCopy>;
type Overrides = Partial<Record<string, GateMode>>;

/** Below 640px a table here is not drawn as columns: each row stacks as lines of a two-column grid
 *  parted by hairlines, its header hidden, so nothing scrolls sideways and the select stays in view. */
export const STACKED = {
	table: "max-sm:block",
	head: "max-sm:hidden",
	body: "max-sm:block",
	row: "max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:py-3",
	cell: "max-sm:min-w-0 max-sm:px-0 max-sm:py-0!",
	wide: "max-sm:col-span-2",
	/** a column the stacked row reads from its own line instead */
	columnOnly: "max-sm:hidden",
	/** the line that stands in for those columns */
	stackOnly: "sm:hidden",
} as const;

/** The select's value for "no override": the profile decides. */
const DEFAULT = "";
const PROFILES: readonly GateProfile[] = ["strict", "standard", "yolo"];

const modeLabel = (t: Copy, mode: GateMode) => t(`settings.project.gates.mode.${mode}`);

const defaultLabel = (t: Copy, d: GateDefault) => (typeof d === "string" ? modeLabel(t, d) : t("settings.project.gates.ownSwitch", { key: d.key }));

function cameFrom(t: Copy, g: ResolvedGate) {
	if (g.from === "override") return t("settings.project.gates.from.override");
	if (g.from === "key") return t("settings.project.gates.from.key", { key: g.key });
	return t("settings.project.gates.from.profile", { profile: g.profile });
}

const sameOverrides = (a: Overrides, b: Overrides) => {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((k) => a[k] === b[k]);
};

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
	const [overrides, setOverrides] = useState<Overrides>(view.overrides);
	const [reason, setReason] = useState("");
	const off = !canEdit || !view.declared;
	const dirty = profile !== view.profile || !sameOverrides(overrides, view.overrides);
	const resolved = new Map(view.gates.map((g) => [g.id, g]));

	const setMode = (id: string, value: string) =>
		setOverrides((was) => {
			const { [id]: _dropped, ...rest } = was;
			return value === DEFAULT ? rest : { ...rest, [id]: value as GateMode };
		});
	const save = () => {
		if (view.revision === null) return;
		write.mutate({ baseRevision: view.revision, profile, overrides, reason: reason.trim() });
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
				<Table aria-label={t("settings.project.gates.title")} className={STACKED.table} data-testid="gates-table">
					<THead className={STACKED.head}>
						<TR>
							<TH>{t("settings.project.gates.col.gate")}</TH>
							{PROFILES.map((p) => (
								<TH key={p}>{t(`settings.project.gates.profile.${p}`)}</TH>
							))}
							<TH>{t("settings.project.gates.col.mode")}</TH>
							<TH>{t("settings.project.gates.col.from")}</TH>
						</TR>
					</THead>
					<TBody className={STACKED.body}>
						{catalog.gates.map((g) => (
							<GateModes key={g.id} gate={g} now={resolved.get(g.id as ResolvedGate["id"])} value={overrides[g.id] ?? DEFAULT} disabled={off} onChange={(v) => setMode(g.id, v)} />
						))}
					</TBody>
				</Table>
			</SettingsGroup>
			<SettingsGroup id="kernel" title={t("settings.project.gates.kernel")} summary={t("settings.project.gates.kernelAlways")}>
				<ul className="divide-y divide-line-subtle border-y border-line-subtle" data-testid="gates-kernel">
					{catalog.kernel.map((k) => (
						<li key={k.id} className="fg-body-sm flex flex-wrap gap-x-3 py-2 text-fg">
							<code className="font-mono text-muted" translate="no">
								{k.id}
							</code>
							<span>{k.holds}</span>
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
				<ChangesTable changes={view.changes} />
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

function GateModes({ gate, now, value, disabled, onChange }: { gate: GateEntry; now: ResolvedGate | undefined; value: string; disabled: boolean; onChange: (v: string) => void }) {
	const t = useCopy();
	const options = [{ value: DEFAULT, label: t("settings.project.gates.profileDefault") }, ...gate.modes.map((m) => ({ value: m, label: modeLabel(t, m) }))];
	return (
		<TR data-testid={`gate-${gate.id}`} className={STACKED.row}>
			<TD className={cn("min-w-60", STACKED.cell, STACKED.wide)}>
				<p className="font-semibold">{gate.title}</p>
				<p className="fg-caption text-muted">{gate.refuses}</p>
			</TD>
			{PROFILES.map((p) => (
				<TD key={p} className={cn("min-w-28 text-muted", STACKED.columnOnly)}>
					{defaultLabel(t, gate.defaults[p])}
				</TD>
			))}
			<TD className={cn("min-w-40", STACKED.cell)}>
				<Picker aria-label={t("settings.project.gates.modeOf", { gate: gate.title })} value={value} disabled={disabled} options={options} width="min-w-36" onChange={(e) => onChange(e.target.value)} />
			</TD>
			<TD className={cn("min-w-40", STACKED.cell)}>
				{now ? (
					<>
						<p>{modeLabel(t, now.mode)}</p>
						<p className="fg-caption text-muted">{cameFrom(t, now)}</p>
					</>
				) : null}
			</TD>
			<TD className={cn("fg-caption text-muted", STACKED.cell, STACKED.wide, STACKED.stackOnly)} data-testid="stacked-defaults">
				{PROFILES.map((p) => t("settings.project.gates.defaultOf", { profile: t(`settings.project.gates.profile.${p}`), mode: defaultLabel(t, gate.defaults[p]) })).join(" · ")}
			</TD>
		</TR>
	);
}

/** "gate a → b" for each override the change set, moved or removed; "default" where none was held. */
function overridesMoved(t: Copy, from: Overrides, to: Overrides): string[] {
	const ids = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((id) => from[id] !== to[id]);
	const side = (m: GateMode | undefined) => (m ? modeLabel(t, m) : t("settings.project.gates.profileDefault"));
	return ids.map((id) => `${id} ${side(from[id])} → ${side(to[id])}`);
}

function ChangesTable({ changes }: { changes: GateChange[] }) {
	const t = useCopy();
	const time = useTimeFormat();
	if (changes.length === 0) return <p className="fg-body-sm text-muted">{t("settings.project.gates.changesNone")}</p>;
	return (
		<Table aria-label={t("settings.project.gates.changes")} data-testid="gates-changes" className={STACKED.table}>
			<THead className={STACKED.head}>
				<TR>
					<TH>{t("settings.project.gates.col.when")}</TH>
					<TH>{t("settings.project.gates.col.who")}</TH>
					<TH>{t("settings.project.gates.profile")}</TH>
					<TH>{t("settings.project.gates.col.overrides")}</TH>
					<TH>{t("settings.project.gates.col.why")}</TH>
				</TR>
			</THead>
			<TBody className={STACKED.body}>
				{changes.map((c) => {
					const moved = overridesMoved(t, c.overridesFrom ?? {}, c.overridesTo ?? {});
					return (
						<TR key={`${c.at}:${c.configRevision}`} className={STACKED.row}>
							<TD className={cn("whitespace-nowrap", STACKED.cell)}>{time.dateTime(c.at)}</TD>
							<TD className={STACKED.cell}>{c.actorName ?? (c.actorKind === "forge" ? t("settings.project.gates.forge") : (c.actorUserId ?? "—"))}</TD>
							<TD className={cn("whitespace-nowrap", STACKED.cell, STACKED.wide)}>
								{c.profileFrom ? t(`settings.project.gates.profile.${c.profileFrom}`) : "—"} → {t(`settings.project.gates.profile.${c.profileTo}`)}
							</TD>
							<TD className={cn("min-w-56", STACKED.cell, STACKED.wide)}>
								{moved.length === 0
									? "—"
									: moved.map((m) => (
											<p key={m} className="font-mono text-12" translate="no">
												{m}
											</p>
										))}
							</TD>
							<TD className={cn("min-w-56", STACKED.cell, STACKED.wide)}>
								{c.cause !== "set" && (
									<p className="fg-caption text-muted">
										{t("settings.project.gates.raisedAfter", { cause: t(`settings.project.gates.cause.${c.cause}`) })}
										{c.ref ? ` · ${c.ref}` : ""}
									</p>
								)}
								<p>{c.reason}</p>
							</TD>
						</TR>
					);
				})}
			</TBody>
		</Table>
	);
}
