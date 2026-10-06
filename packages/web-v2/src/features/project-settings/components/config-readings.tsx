"use client";

import { Badge, Banner, PageSectionTitle, enumLabel, ErrorState, MonoTag, StatusBadge, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { canonicalJson } from "@forge/contracts/document-patch";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useEffectiveConfig, useEnvironmentState } from "@/features/project-config/hooks";
import type { EffectiveLayer, EnvironmentState, ProbeOutcome } from "@/features/project-config/types";

const LAYER_TEXT: Record<EffectiveLayer, string> = {
	project: "project document",
	policy: "policy",
	"testing-profile": "testing profile",
	"device-binding": "device binding",
	binding: "binding",
};

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);

export function EffectiveSection({ projectId }: { projectId: string }) {
	const q = useEffectiveConfig(projectId);
	const heading = (
		<>
			<PageSectionTitle className="fg-label text-fg">Effective config</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">
				What a run reads, computed on read: each value with the layer and revision it came from.
			</p>
		</>
	);
	if (q.isLoading) return <Skeleton className="mt-6 h-32 w-full rounded-md" />;
	if (!q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
	const e = q.data;
	return (
		<section aria-label="Effective config" className="mt-6 border-t border-line pt-5">
			{heading}
			{!e.declared ? (
				<Banner tone="attention">No project document is declared, so there is no effective config to explain.</Banner>
			) : (
				<>
					<p className="fg-caption mb-2 text-subtle">
						Read at project document revision {e.revision}
						{e.device ? `, for device ${e.device}` : ", as a person — no device binding layer applies to a browser"}.
					</p>
					{e.undeclared.length > 0 && (
						<p className="fg-caption mb-2 text-subtle">
							Not declared: {e.undeclared.map((l) => LAYER_TEXT[l]).join(", ")}.
						</p>
					)}
					<Table>
						<THead>
							<TR>
								<TH>Value</TH>
								<TH>From</TH>
								<TH>Revision</TH>
								<TH>Holds</TH>
							</TR>
						</THead>
						<TBody>
							{Object.entries(e.values).map(([pointer, v]) => (
								<TR key={pointer}>
									<TD>
										<code>{pointer}</code>
									</TD>
									<TD>
										<Badge tone="cobalt">{LAYER_TEXT[v.from]}</Badge>
									</TD>
									<TD>{v.revision ?? "—"}</TD>
									<TD>
										<code className="break-all">{clip(canonicalJson(v.value))}</code>
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

function probeLine(p: ProbeOutcome): string {
	switch (p.status) {
		case "confirmed":
			return `serves ${p.observed}`;
		case "mismatch":
			return `serves ${p.observed}, expected ${p.expected}`;
		case "uncompared":
			return `serves ${p.observed}; ${p.error}`;
		case "unreachable":
			return p.error;
	}
}

function sourceLine(s: Extract<EnvironmentState, { deployment: unknown }>["source"]): string {
	if (s.kind === "revision") return s.revision.slice(0, 12);
	return s.kind === "unrecorded" ? "not recorded by the platform" : "not a git project";
}

function EnvironmentRow({ env }: { env: EnvironmentState }) {
	return (
		<section className="border-t border-line-subtle pt-3" aria-label={`Environment ${env.environment}`}>
			<div className="flex flex-wrap items-center gap-2">
				<MonoTag>{env.environment}</MonoTag>
				<StatusBadge family="deployment" value={env.state} />
				<span className="fg-caption text-subtle">Evidence: {enumLabel("environmentEvidence", env.evidence)}</span>
			</div>
			{env.state === "unknown" ? (
				<p className="fg-body-sm mt-2 text-muted">
					{enumLabel("environmentCause", env.reason.cause)}: {env.reason.message}
				</p>
			) : (
				<dl className="fg-body-sm mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
					<div>
						<dt className="fg-caption text-subtle">Deployed revision</dt>
						<dd className="font-mono">{sourceLine(env.source)}</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">Deployment</dt>
						<dd>
							{env.deployment.provider} <code>{env.deployment.id}</code> <StatusBadge family="deployment" value={env.deployment.status} /> at {env.deployment.at}
						</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">Artifact</dt>
						<dd>{env.artifact ? `${enumLabel("artifactKind", env.artifact.kind)} ${env.artifact.id}` : "none reported by the platform"}</dd>
					</div>
					<div>
						<dt className="fg-caption text-subtle">Probes</dt>
						<dd>
							{env.probes && env.probes.length > 0 ? (
								<ul className="space-y-1">
									{env.probes.map((p) => (
										<li key={`${p.url}:${p.identifies}`}>
											<StatusBadge family="probe" value={p.status} /> <code>{p.url}</code> ({p.identifies}) —{" "}
											{probeLine(p)}
										</li>
									))}
								</ul>
							) : (
								"none declared"
							)}
						</dd>
					</div>
				</dl>
			)}
		</section>
	);
}

export function EnvironmentStateSection({ projectId }: { projectId: string }) {
	const q = useEnvironmentState(projectId);
	const noDocument = q.error instanceof ApiError && q.error.code === "PROJECT_DOCUMENT_NOT_FOUND";
	return (
		<section aria-label="Environment state" className="mt-6 border-t border-line pt-5">
			<PageSectionTitle className="fg-label text-fg">Environments</PageSectionTitle>
			<p className="fg-body-sm mt-1 mb-3 text-muted">
				What each environment runs, read from its deployment record and its runtime probes.
			</p>
			{q.isLoading ? (
				<Skeleton className="h-24 w-full rounded-md" />
			) : noDocument ? (
				<Banner tone="attention">No project document is declared, so it names no environment.</Banner>
			) : !q.data ? (
				<ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
			) : q.data.environments.length === 0 ? (
				<p className="fg-caption text-subtle">Project document revision {q.data.revision} declares no environment.</p>
			) : (
				<div className="space-y-2">
					<p className="fg-caption text-subtle">Read against project document revision {q.data.revision}.</p>
					{q.data.environments.map((env) => (
						<EnvironmentRow key={env.environment} env={env} />
					))}
				</div>
			)}
		</section>
	);
}
