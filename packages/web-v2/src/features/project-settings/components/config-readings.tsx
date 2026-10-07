"use client";

import { Badge, Banner, PageSectionTitle, enumLabel, ErrorState, MonoTag, StatusBadge, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { canonicalJson } from "@forge/contracts/document-patch";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useEffectiveConfig, useEnvironmentState } from "@/features/project-config/hooks";
import type { EffectiveLayer, EnvironmentState, ProbeOutcome } from "@/features/project-config/types";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";

const layerText = (t: Copy, layer: EffectiveLayer) => t(`settings.project.raw.layer.${layer}` as ProductCopyKey);

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);

export function EffectiveSection({ projectId }: { projectId: string }) {
	const t = useCopy();
	const q = useEffectiveConfig(projectId);
	const heading = (
		<>
			<PageSectionTitle className="fg-label text-fg">{t("settings.project.raw.effective")}</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">{t("settings.project.raw.effectiveLead")}</p>
		</>
	);
	if (q.isLoading) return <Skeleton className="mt-6 h-32 w-full rounded-md" />;
	if (!q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
	const e = q.data;
	return (
		<section aria-label={t("settings.project.raw.effective")} className="mt-6 border-t border-line pt-5">
			{heading}
			{!e.declared ? (
				<Banner tone="attention">{t("settings.project.raw.effectiveNone")}</Banner>
			) : (
				<>
					<p className="fg-caption mb-2 text-subtle">
						{e.device
							? t("settings.project.raw.effectiveReadDevice", { revision: e.revision, device: e.device })
							: t("settings.project.raw.effectiveReadPerson", { revision: e.revision })}
					</p>
					{e.undeclared.length > 0 && (
						<p className="fg-caption mb-2 text-subtle">
							{t("settings.project.raw.effectiveUndeclared", { layers: e.undeclared.map((l) => layerText(t, l)).join(", ") })}
						</p>
					)}
					<Table>
						<THead>
							<TR>
								<TH>{t("settings.project.raw.colValue")}</TH>
								<TH>{t("settings.project.raw.colFrom")}</TH>
								<TH>{t("settings.project.raw.colRevision")}</TH>
								<TH>{t("settings.project.raw.colHolds")}</TH>
							</TR>
						</THead>
						<TBody>
							{Object.entries(e.values).map(([pointer, v]) => (
								<TR key={pointer}>
									<TD>
										<code translate="no">{pointer}</code>
									</TD>
									<TD>
										<Badge tone="cobalt">{layerText(t, v.from)}</Badge>
									</TD>
									<TD>{v.revision ?? "—"}</TD>
									<TD>
										<code className="break-all" translate="no">
											{clip(canonicalJson(v.value))}
										</code>
									</TD>
								</TR>
							))}
						</TBody>
					</Table>
				</>
			)}
		</section>
	);
}

function probeLine(p: ProbeOutcome, t: Copy): string {
	switch (p.status) {
		case "confirmed":
			return t("settings.project.raw.probeServes", { observed: p.observed });
		case "mismatch":
			return t("settings.project.raw.probeMismatch", { observed: p.observed, expected: p.expected });
		case "uncompared":
			return `${t("settings.project.raw.probeServes", { observed: p.observed })}; ${p.error}`;
		case "unreachable":
			return p.error;
	}
}

function sourceLine(s: Extract<EnvironmentState, { deployment: unknown }>["source"], t: Copy): string {
	if (s.kind === "revision") return s.revision.slice(0, 12);
	return s.kind === "unrecorded" ? t("settings.project.raw.sourceUnrecorded") : t("settings.project.raw.sourceNonGit");
}

function EnvironmentRow({ env }: { env: EnvironmentState }) {
	const t = useCopy();
	return (
		<section className="border-t border-line-subtle pt-3" aria-label={t("settings.project.delivery.environmentNamed", { name: env.environment })}>
			<div className="flex flex-wrap items-center gap-2">
				<MonoTag>{env.environment}</MonoTag>
				<StatusBadge family="deployment" value={env.state} />
				<span className="fg-caption text-subtle">{t("settings.project.raw.evidence", { evidence: enumLabel("environmentEvidence", env.evidence) })}</span>
			</div>
			{env.state === "unknown" ? (
				<p className="fg-body-sm mt-2 text-muted">
					{enumLabel("environmentCause", env.reason.cause)}: {env.reason.message}
				</p>
			) : (
				<dl className="fg-body-sm mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
					<div>
						<dt className="fg-caption text-subtle">{t("settings.project.raw.deployedRevision")}</dt>
						<dd className="font-mono">{sourceLine(env.source, t)}</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">{t("settings.project.raw.deployment")}</dt>
						<dd>
							{env.deployment.provider} <code translate="no">{env.deployment.id}</code> <StatusBadge family="deployment" value={env.deployment.status} />{" "}
							{env.deployment.at}
						</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">{t("settings.project.raw.artifact")}</dt>
						<dd>{env.artifact ? `${enumLabel("artifactKind", env.artifact.kind)} ${env.artifact.id}` : t("settings.project.raw.noArtifact")}</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">{t("settings.project.raw.probes")}</dt>
						<dd>
							{env.probes && env.probes.length > 0 ? (
								<ul className="space-y-1">
									{env.probes.map((p) => (
										<li key={`${p.url}:${p.identifies}`}>
											<StatusBadge family="probe" value={p.status} /> <code>{p.url}</code> ({p.identifies}) —{" "}
											{probeLine(p, t)}
										</li>
									))}
								</ul>
							) : (
								t("settings.project.raw.noProbes")
							)}
						</dd>
					</div>
				</dl>
			)}
		</section>
	);
}

export function EnvironmentStateSection({ projectId }: { projectId: string }) {
	const t = useCopy();
	const q = useEnvironmentState(projectId);
	const noDocument = q.error instanceof ApiError && q.error.code === "PROJECT_DOCUMENT_NOT_FOUND";
	return (
		<section aria-label={t("settings.project.raw.environmentState")} className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">{t("settings.project.raw.environmentState")}</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">{t("settings.project.raw.environmentStateLead")}</p>
			{q.isLoading ? (
				<Skeleton className="h-24 w-full rounded-md" />
			) : noDocument ? (
				<Banner tone="attention">{t("settings.project.raw.environmentNone")}</Banner>
			) : !q.data ? (
				<ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
			) : q.data.environments.length === 0 ? (
				<p className="fg-caption text-subtle">{t("settings.project.raw.environmentEmpty", { revision: q.data.revision })}</p>
			) : (
				<div className="space-y-2">
					<p className="fg-caption text-subtle">{t("settings.project.raw.environmentReadAt", { revision: q.data.revision })}</p>
					{q.data.environments.map((env) => (
						<EnvironmentRow key={env.environment} env={env} />
					))}
				</div>
			)}
		</section>
	);
}
