"use client";

// Settings → Delivery: where work is made and how it ships. The repository and its branches, the
// environments it goes live in, the release path between them and who runs the work are fields of
// the project document and the policy, held as one draft each and saved together by the section's
// one save bar, through the same document writes the raw editors send. What the release can do
// right now is read underneath, from core's release readiness.
import { useState } from "react";
import { Button, IconButton, Input, Skeleton } from "@/design";
import { useBindingDocuments, usePolicyDocument, useWritePolicy } from "@/features/project-config/hooks";
import { type DocumentDraft, sectionOf, useDocumentDraft } from "@/features/project-config/use-document-draft";
import { useProviderLabel } from "@/features/integrations/providers/registry";
import type { ProjectDetail } from "@/features/projects/types";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { policyTemplate } from "../config-templates";
import { ChoiceSetting, optionsOf, Picker, SaveBar, SettingGroup, SettingRow, SwitchSetting, TextSetting } from "./setting-controls";
import { UndeclaredNotice, useProjectDraft } from "./general-section";
import { ReleaseSection } from "./release-section";

const TIERS = ["production", "staging", "preview", "dev"] as const;
const TRIGGERS = ["on-land", "on-request", "provider"] as const;
const ISOLATIONS = ["worktree", "branch", "remote-draft", "none"] as const;
const GATES = ["none", "github-check", "gitlab-pipeline"] as const;
const ROLLBACKS = ["revert-and-redeploy", "redeploy-previous", "restore-previous-theme", "none"] as const;
const VIA = ["merge", "cherry-pick"] as const;
const EXTERNAL = "external";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A list of names typed as "dev, main"; blanks and repeats dropped. */
function CommaList({ draft, path, label, effect, disabled }: { draft: DocumentDraft; path: string[]; label: string; effect: string; disabled: boolean }) {
	const text = list(draft.get(path)).map(String).join(", ");
	return (
		<SettingRow
			label={label}
			effect={effect}
			refusals={draft.refusedAt(path)}
			control={
				<Input
					aria-label={label}
					key={text}
					defaultValue={text}
					className="font-mono"
					disabled={disabled}
					onBlur={(e) => {
						const next = [...new Set(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))];
						if (next.join(", ") !== text) draft.set(path, next);
					}}
				/>
			}
		/>
	);
}

function RepositoryGroup({ draft, off }: { draft: DocumentDraft; off: boolean }) {
	const t = useCopy();
	const source = obj(draft.get(["source"]));
	const gateType = str(obj(obj(draft.get(["validation"])).gate).type) || "none";
	return (
		<SettingGroup id="repository" title={t("settings.project.delivery.repository")} lead={t("settings.project.delivery.repositoryLead")}>
			{source.type === "git" ? (
				<>
					<TextSetting draft={draft} path={["source", "git", "repository"]} label={t("settings.project.delivery.repo")} effect={t("settings.project.delivery.repoEffect")} placeholder="github.com/owner/repo" mono disabled={off} />
					<TextSetting draft={draft} path={["source", "git", "defaultBranch"]} label={t("settings.project.delivery.defaultBranch")} effect={t("settings.project.delivery.defaultBranchEffect")} mono disabled={off} />
					<CommaList draft={draft} path={["source", "git", "branches"]} label={t("settings.project.delivery.branches")} effect={t("settings.project.delivery.branchesEffect")} disabled={off} />
				</>
			) : source.type === "storefront" ? (
				<p className="fg-body-sm text-muted">{t("settings.project.delivery.storefrontSource", { provider: str(obj(source.storefront).provider) })}</p>
			) : (
				<div className="flex flex-wrap items-center gap-3">
					<p className="fg-body-sm flex-1 text-muted">{t("settings.project.delivery.noSource")}</p>
					{!off && (
						<Button
							variant="secondary"
							onClick={() => draft.set(["source"], { type: "git", git: { repository: "", defaultBranch: "main", branches: ["main"] } })}
						>
							{t("settings.project.delivery.declareRepo")}
						</Button>
					)}
				</div>
			)}
			<ChoiceSetting draft={draft} path={["workspace", "isolation"]} options={optionsOf(t, "settings.project.delivery.isolation", ISOLATIONS)} label={t("settings.project.delivery.isolationLabel")} effect={t("settings.project.delivery.isolationEffect")} disabled={off} />
			<SettingRow
				label={t("settings.project.delivery.gate")}
				effect={t("settings.project.delivery.gateEffect")}
				refusals={draft.refusedAt(["validation"])}
				control={
					<div className="flex flex-col gap-2 sm:flex-row">
						<Picker
							aria-label={t("settings.project.delivery.gate")}
							value={gateType}
							disabled={off}
							width="sm:max-w-xs"
							options={optionsOf(t, "settings.project.delivery.gateType", GATES)}
							onChange={(e) => draft.set(["validation", "gate"], e.target.value === "none" ? { type: "none" } : { type: e.target.value, name: "" })}
						/>
						{gateType !== "none" && (
							<Input
								aria-label={t("settings.project.delivery.gateName")}
								placeholder={t("settings.project.delivery.gateName")}
								value={str(obj(obj(draft.get(["validation"])).gate).name)}
								disabled={off}
								onChange={(e) => draft.set(["validation", "gate", "name"], e.target.value)}
							/>
						)}
					</div>
				}
			/>
		</SettingGroup>
	);
}

function bindingOptions(bindings: { document: Obj }[], providerLabel: (p: string) => string, t: Copy) {
	return [
		...bindings
			.filter((b) => b.document.role === "deploy")
			.map((b) => {
				const target = obj(b.document.target);
				const id = String(b.document.id);
				return { value: id, label: `${providerLabel(str(target.provider))}${target.label ? ` · ${str(target.label)}` : ` · ${id.slice(0, 8)}`}` };
			}),
		{ value: EXTERNAL, label: t("settings.project.delivery.deployExternal") },
	];
}

function Probes({ draft, base, off }: { draft: DocumentDraft; base: string[]; off: boolean }) {
	const t = useCopy();
	const path = [...base, "verification", "runtime"];
	const probes = list(draft.get(path));
	const setProbes = (next: unknown[]) => draft.set([...base, "verification"], next.length ? { runtime: next } : undefined);
	return (
		<SettingRow
			label={t("settings.project.delivery.probes")}
			effect={t("settings.project.delivery.probesEffect")}
			refusals={draft.refusedAt([...base, "verification"])}
			control={
				<div className="space-y-2">
					{probes.map((p, i) => {
						const probe = obj(p);
						const at = [...path, String(i)];
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: a probe is its position in the document's list; it has no identity of its own to key by
							<div key={`probe-${i}`} className="flex flex-col gap-2 sm:flex-row sm:items-center">
								<Input aria-label={t("settings.project.delivery.probeUrl")} placeholder="https://example.com/version" value={str(probe.url)} disabled={off} className="font-mono" onChange={(e) => draft.set([...at, "url"], e.target.value)} />
								<Input aria-label={t("settings.project.delivery.probePath")} placeholder="commit" value={str(probe.path)} disabled={off} className="font-mono sm:max-w-40" onChange={(e) => draft.set([...at, "path"], e.target.value)} />
								<Picker
									aria-label={t("settings.project.delivery.probeIdentifies")}
									value={str(probe.identifies) || "source"}
									disabled={off}
									width="sm:max-w-44"
									options={optionsOf(t, "settings.project.delivery.identifies", ["source", "artifact"])}
									onChange={(e) => draft.set([...at, "identifies"], e.target.value)}
								/>
								{!off && <IconButton icon="trash" aria-label={t("settings.project.delivery.probeRemove")} onClick={() => setProbes(probes.filter((_, n) => n !== i))} />}
							</div>
						);
					})}
					{!off && probes.length < 3 && (
						<Button variant="ghost" size="sm" icon="plus" onClick={() => setProbes([...probes, { type: "http", url: "", path: "", identifies: "source" }])}>
							{t("settings.project.delivery.probeAdd")}
						</Button>
					)}
				</div>
			}
		/>
	);
}

function EnvironmentRow({ draft, name, options, off }: { draft: DocumentDraft; name: string; options: { value: string; label: string }[]; off: boolean }) {
	const t = useCopy();
	const base = ["environments", name];
	const env = obj(draft.get(base));
	const deployment = obj(env.deployment);
	const bound = typeof deployment.binding === "string" ? deployment.binding : EXTERNAL;
	const environments = obj(draft.get(["environments"]));
	return (
		<section className="space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0" aria-label={t("settings.project.delivery.environmentNamed", { name })}>
			<div className="flex items-center gap-2">
				<h4 className="fg-h4 font-mono text-fg" translate="no">
					{name}
				</h4>
				{env.tier === "production" && <span className="fg-caption text-accent-text">{t("settings.project.delivery.isProduction")}</span>}
				<span className="flex-1" />
				{!off && (
					<IconButton
						icon="trash"
						aria-label={t("settings.project.delivery.environmentRemove", { name })}
						onClick={() => {
							const { [name]: _gone, ...rest } = environments;
							draft.set(["environments"], rest);
						}}
					/>
				)}
			</div>
			<ChoiceSetting draft={draft} path={[...base, "tier"]} options={optionsOf(t, "settings.project.delivery.tier", TIERS)} label={t("settings.project.delivery.tierLabel")} effect={t("settings.project.delivery.tierEffect")} disabled={off} />
			<TextSetting draft={draft} path={[...base, "deploysFrom"]} optional mono label={t("settings.project.delivery.deploysFrom")} effect={t("settings.project.delivery.deploysFromEffect")} disabled={off} />
			<SettingRow
				label={t("settings.project.delivery.deployBy")}
				effect={t("settings.project.delivery.deployByEffect")}
				refusals={draft.refusedAt([...base, "deployment"])}
				control={
					<Picker
						aria-label={t("settings.project.delivery.deployBy")}
						value={bound}
						disabled={off}
						width="sm:max-w-md"
						options={options.some((o) => o.value === bound) ? options : [{ value: bound, label: bound }, ...options]}
						onChange={(e) =>
							draft.set(
								[...base, "deployment"],
								e.target.value === EXTERNAL ? { mode: EXTERNAL } : { binding: e.target.value, trigger: str(deployment.trigger) || "on-request" },
							)
						}
					/>
				}
			/>
			{bound !== EXTERNAL && (
				<ChoiceSetting draft={draft} path={[...base, "deployment", "trigger"]} options={optionsOf(t, "settings.project.delivery.trigger", TRIGGERS)} label={t("settings.project.delivery.triggerLabel")} effect={t("settings.project.delivery.triggerEffect")} disabled={off} />
			)}
			<TextSetting draft={draft} path={[...base, "url"]} optional mono placeholder="https://" label={t("settings.project.delivery.url")} effect={t("settings.project.delivery.urlEffect")} disabled={off} />
			<Probes draft={draft} base={base} off={off} />
		</section>
	);
}

function EnvironmentsGroup({ draft, projectId, off }: { draft: DocumentDraft; projectId: string; off: boolean }) {
	const t = useCopy();
	const providerLabel = useProviderLabel();
	const bindings = useBindingDocuments(projectId);
	const options = bindingOptions((bindings.data?.bindings ?? []) as { document: Obj }[], providerLabel, t);
	const environments = obj(draft.get(["environments"]));
	const names = Object.keys(environments);
	const [adding, setAdding] = useState("");
	const valid = /^[a-z][a-z0-9-]{0,62}$/.test(adding) && !names.includes(adding);
	return (
		<SettingGroup id="environments" title={t("settings.project.delivery.environments")} lead={t("settings.project.delivery.environmentsLead")}>
			{names.length === 0 && <p className="fg-body-sm text-muted">{t("settings.project.delivery.noEnvironments")}</p>}
			{names.map((name) => (
				<EnvironmentRow key={name} draft={draft} name={name} options={options} off={off} />
			))}
			{!off && (
				<div className="flex flex-col gap-2 border-t border-line-subtle pt-4 sm:flex-row sm:items-end">
					<div className="flex-1">
						<SettingRow
							label={t("settings.project.delivery.environmentNew")}
							effect={adding && !valid ? t("settings.project.delivery.environmentNameRule") : undefined}
							control={<Input aria-label={t("settings.project.delivery.environmentNew")} value={adding} placeholder="staging" className="font-mono" onChange={(e) => setAdding(e.target.value)} />}
						/>
					</div>
					<Button
						variant="secondary"
						icon="plus"
						disabled={!valid}
						className="min-h-11"
						onClick={() => {
							draft.set(["environments", adding], { tier: names.length === 0 ? "production" : "staging", deployment: { mode: EXTERNAL } });
							setAdding("");
						}}
					>
						{t("settings.project.delivery.environmentAdd")}
					</Button>
				</div>
			)}
		</SettingGroup>
	);
}

/** The path a landed change takes, said as one sentence from what the draft declares. */
function pathSentence(draft: DocumentDraft, t: Copy): string {
	const branch = str(obj(obj(draft.get(["source"])).git).defaultBranch);
	const environments = obj(draft.get(["environments"]));
	const production = Object.entries(environments).find(([, e]) => obj(e).tier === "production");
	const promotions = list(draft.get(["promotions"])).map(obj);
	if (!production) return t("settings.project.delivery.pathNoProduction");
	const [name, env] = production;
	const from = str(obj(env).deploysFrom) || branch;
	if (promotions.length === 0) return t("settings.project.delivery.pathDirect", { branch: branch || "—", env: name, from: from || "—" });
	const chain = [branch, ...promotions.map((p) => str(p.to))].filter(Boolean).join(" → ");
	return t("settings.project.delivery.pathPromoted", { chain, env: name, from: from || "—" });
}

function ReleasePathGroup({ draft, off }: { draft: DocumentDraft; off: boolean }) {
	const t = useCopy();
	const promotions = list(draft.get(["promotions"]));
	return (
		<SettingGroup id="release-path" title={t("settings.project.delivery.releasePath")} lead={pathSentence(draft, t)}>
			<SettingRow
				label={t("settings.project.delivery.promotions")}
				effect={t("settings.project.delivery.promotionsEffect")}
				refusals={draft.refusedAt(["promotions"])}
				control={
					<div className="space-y-2">
						{promotions.length === 0 && <p className="fg-body-sm text-muted">{t("settings.project.delivery.noPromotions")}</p>}
						{promotions.map((p, i) => {
							const promotion = obj(p);
							const at = ["promotions", String(i)];
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: a promotion is its position in the document's list; it has no identity of its own to key by
								<div key={`promotion-${i}`} className="flex flex-col gap-2 sm:flex-row sm:items-center">
									<Input aria-label={t("settings.project.delivery.promotionFrom")} value={str(promotion.from)} disabled={off} className="font-mono" onChange={(e) => draft.set([...at, "from"], e.target.value)} />
									<span aria-hidden className="hidden text-subtle sm:inline">→</span>
									<Input aria-label={t("settings.project.delivery.promotionTo")} value={str(promotion.to)} disabled={off} className="font-mono" onChange={(e) => draft.set([...at, "to"], e.target.value)} />
									<Picker
										aria-label={t("settings.project.delivery.promotionVia")}
										value={str(promotion.via) || "merge"}
										disabled={off}
										width="sm:max-w-44"
										options={optionsOf(t, "settings.project.delivery.via", VIA)}
										onChange={(e) => draft.set([...at, "via"], e.target.value)}
									/>
									{!off && (
										<IconButton icon="trash" aria-label={t("settings.project.delivery.promotionRemove")} onClick={() => draft.set(["promotions"], promotions.filter((_, n) => n !== i))} />
									)}
								</div>
							);
						})}
						{!off && promotions.length < 5 && (
							<Button variant="ghost" size="sm" icon="plus" onClick={() => draft.set(["promotions"], [...promotions, { from: "", to: "", via: "merge" }])}>
								{t("settings.project.delivery.promotionAdd")}
							</Button>
						)}
					</div>
				}
			/>
			<ChoiceSetting draft={draft} path={["rollback", "strategy"]} options={optionsOf(t, "settings.project.delivery.rollback", ROLLBACKS)} label={t("settings.project.delivery.rollbackLabel")} effect={t("settings.project.delivery.rollbackEffect")} disabled={off} />
			<SwitchSetting draft={draft} path={["release", "approval", "required"]} fallback={false} label={t("settings.project.delivery.releaseApproval")} effect={t("settings.project.delivery.releaseApprovalEffect")} disabled={off} />
		</SettingGroup>
	);
}

function AutomationGroup({ policy, off }: { policy: DocumentDraft; off: boolean }) {
	const t = useCopy();
	return (
		<SettingGroup id="automation" title={t("settings.project.delivery.automation")} lead={policy.declared ? t("settings.project.delivery.automationLead") : t("settings.project.delivery.automationUndeclared")}>
			<ChoiceSetting draft={policy} path={["qa"]} options={optionsOf(t, "settings.project.delivery.qa", ["self", "independent"])} label={t("settings.project.delivery.qaLabel")} effect={t("settings.project.delivery.qaEffect")} disabled={off} />
			<SettingRow
				inline
				label={t("settings.project.delivery.intake")}
				effect={t("settings.project.delivery.intakeEffect")}
				refusals={policy.refusedAt(["intake"])}
				control={
					<Picker
						aria-label={t("settings.project.delivery.intake")}
						value={str(obj(policy.get(["intake"])).mode) || "manual"}
						disabled={off}
						width="w-44"
						options={optionsOf(t, "settings.project.delivery.intakeMode", ["auto", "manual"])}
						onChange={(e) => policy.set(["intake", "mode"], e.target.value)}
					/>
				}
			/>
		</SettingGroup>
	);
}

export function DeliverySection({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
	const draft = useProjectDraft(project.id);
	const policyQ = usePolicyDocument(project.id);
	const policy = useDocumentDraft(policyQ.data, useWritePolicy(project.id), () => policyQ.refetch(), policyTemplate());
	const section = sectionOf([draft, policy]);
	if (draft.loading || !draft.ready) return <Skeleton className="h-64 w-full rounded-md" />;
	const off = !canEdit || !draft.declared;
	return (
		<div>
			{!draft.declared && <UndeclaredNotice slug={project.slug} />}
			<RepositoryGroup draft={draft} off={off} />
			<EnvironmentsGroup draft={draft} projectId={project.id} off={off} />
			<ReleasePathGroup draft={draft} off={off} />
			{policy.ready && <AutomationGroup policy={policy} off={!canEdit} />}
			<SaveBar section={section} canEdit={canEdit} />
			<div id="release-state" className="scroll-mt-24 border-t border-line pt-6">
				<ReleaseSection projectId={project.id} slug={project.slug} />
			</div>
		</div>
	);
}
