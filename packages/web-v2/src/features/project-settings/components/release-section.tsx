"use client";

// Settings → Delivery → Release state: what a release can do right now, read from core's release
// readiness. Each reason is core's own reading of it (`gates`, the words a release's page uses), drawn
// by its weight: a project as it normally stands (nothing waiting, a release already running) is a
// neutral line, a reason a release cannot start keeps its severity. What the project has not written
// down yet is fixed here, in the page.
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, ErrorState, LEGEND, Skeleton, Textarea } from "@/design";
import { GateLine, type GateTone } from "@/features/releases/components/release-bits";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useReleaseReadiness, useWriteKnowledge } from "../hooks";
import { settingsHref } from "../sections";
import type { ReleaseReadiness } from "../types";

type Gap = ReleaseReadiness["gaps"][number];

/** The reasons that describe how a project stands rather than something wrong with it. */
const STATE_CODES = new Set(["RELEASE_ROSTER_EMPTY", "BATCH_IN_FLIGHT", "NO_RELEASE_GATE"]);

const toneOf = (g: ReleaseReadiness["gates"][number]): GateTone =>
	STATE_CODES.has(g.code) ? "state" : g.kind === "blocker" ? "problem" : "warning";

/** The knowledge entries a release owes, each written here by a person. */
const KNOWLEDGE_GAPS: Partial<Record<Gap, { name: ProductCopyKey; why: ProductCopyKey; placeholder: string }>> = {
	"build-commands": { name: "settings.project.release.gap.buildCommands", why: "settings.project.release.gap.buildCommandsWhy", placeholder: "pnpm install\npnpm build" },
	"test-commands": { name: "settings.project.release.gap.testCommands", why: "settings.project.release.gap.testCommandsWhy", placeholder: "pnpm test" },
	"release-procedure": { name: "settings.project.release.gap.releaseProcedure", why: "settings.project.release.gap.releaseProcedureWhy", placeholder: "1. …" },
};

/** The gaps a field elsewhere on this page or on Connections closes. */
const FIELD_GAPS: Partial<Record<Gap, { why: ProductCopyKey; act: ProductCopyKey; section: "delivery" | "connections"; anchor: string }>> = {
	"release-target": { why: "settings.project.release.gap.releaseTarget", act: "settings.project.release.gap.toEnvironments", section: "delivery", anchor: "environments" },
	"verify-probes": { why: "settings.project.release.gap.verifyProbes", act: "settings.project.release.gap.toProbes", section: "delivery", anchor: "environments" },
	rollback: { why: "settings.project.release.gap.rollback", act: "settings.project.release.gap.toConnection", section: "connections", anchor: "integrations" },
	"rollback-prose": { why: "settings.project.release.gap.rollbackProse", act: "settings.project.release.gap.toConnection", section: "connections", anchor: "integrations" },
};

function stateLine(r: ReleaseReadiness, t: Copy): string {
	if (!r.declarationRead) return t("settings.project.release.unread");
	if (r.hasReleaseGate && r.production) return t("settings.project.release.gated", { env: r.production.environment });
	if (r.targetUndeclared) return t("settings.project.release.undeclaredTarget");
	return t("settings.project.release.noRelease");
}

function Dot({ tone }: { tone: "attention" }) {
	return <span aria-hidden className="mt-[7px] size-1.5 flex-none rounded-full" style={{ background: tone === "attention" ? LEGEND.you.dot : undefined }} />;
}

function KnowledgeGap({ projectId, slug, gap }: { projectId: string; slug: Gap; gap: NonNullable<(typeof KNOWLEDGE_GAPS)[Gap]> }) {
	const t = useCopy();
	const write = useWriteKnowledge(projectId);
	const [open, setOpen] = useState(false);
	const [body, setBody] = useState("");
	const name = t(gap.name);
	return (
		<li className="flex items-start gap-2 py-2 text-13" data-gap={slug}>
			<Dot tone="attention" />
			<div className="min-w-0 flex-1">
				<p>
					<b className="font-semibold">{t("settings.project.release.gap.notWritten", { name })}</b> {t(gap.why)}
				</p>
				{open ? (
					<div className="mt-2 space-y-2">
						<Textarea aria-label={name} value={body} rows={5} className="font-mono" translate="no" placeholder={gap.placeholder} onChange={(e) => setBody(e.target.value)} />
						{write.isError && (
							<p role="alert" className="fg-caption" style={{ color: "var(--red-600)" }}>
								{formatApiError(write.error)}
							</p>
						)}
						<div className="flex gap-2">
							<Button
								variant="primary"
								size="sm"
								disabled={body.trim() === ""}
								loading={write.isPending}
								onClick={() => write.mutate({ slug, title: name, body }, { onSuccess: () => setOpen(false) })}
							>
								{t("settings.project.release.gap.save", { name: name.toLowerCase() })}
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
								{t("common.cancel")}
							</Button>
						</div>
					</div>
				) : (
					<Button variant="ghost" size="sm" className="mt-1 -ml-2" onClick={() => setOpen(true)}>
						{t("settings.project.release.gap.write", { name: name.toLowerCase() })}
					</Button>
				)}
			</div>
		</li>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<dt className="fg-caption text-subtle">{label}</dt>
			<dd className="fg-body-sm text-fg">{children}</dd>
		</div>
	);
}

function ChannelFacts({ r }: { r: ReleaseReadiness }) {
	const t = useCopy();
	if (!r.hasReleaseGate) return null;
	const unread = t("settings.project.release.fact.unread");
	return (
		<dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
			<Fact label={t("settings.project.release.fact.runner")}>
				{!r.channelsRead ? unread : r.releaseRunnerLabel ? <span className="font-mono">{r.releaseRunnerLabel}</span> : t("settings.project.release.fact.anyRunner")}
			</Fact>
			<Fact label={t("settings.project.release.fact.rollback")}>
				{!r.channelsRead ? unread : t(`settings.project.release.fact.rollbackMode.${r.rollbackMode ?? "none"}` as ProductCopyKey)}
			</Fact>
			<Fact label={t("settings.project.release.fact.proof")}>
				{!r.channelsRead ? unread : r.hasVerify ? t("settings.project.release.fact.probe") : t("settings.project.release.fact.recordOnly")}
			</Fact>
		</dl>
	);
}

export function ReleaseSection({ projectId, slug }: { projectId: string; slug: string }) {
	const t = useCopy();
	const q = useReleaseReadiness(projectId);
	const heading = <h3 className="fg-h3 text-accent-text!">{t("settings.project.release.title")}</h3>;
	if (q.isLoading) return <div>{heading}<Skeleton className="mt-3 h-16 w-full rounded-md" /></div>;
	if (q.isError || !q.data) return <div>{heading}<ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} /></div>;
	const r = q.data;
	const knowledge = r.gaps.filter((g) => KNOWLEDGE_GAPS[g]);
	const fields = r.gaps.filter((g) => FIELD_GAPS[g]);
	return (
		<section aria-label={t("settings.project.release.title")}>
			{heading}
			<p className="fg-body-sm mt-1 max-w-[68ch] text-muted">{stateLine(r, t)}</p>
			{r.declarationRead && <ChannelFacts r={r} />}
			{r.gates.length > 0 && (
				<>
					<h4 className="fg-label mt-5 text-fg">{t("settings.project.release.now")}</h4>
					<ul className="divide-y divide-line-subtle">
						{r.gates.map((g) => (
							<GateLine key={`${g.code}:${g.sentence}`} gate={g} slug={slug} tone={toneOf(g)} />
						))}
					</ul>
				</>
			)}
			{knowledge.length + fields.length > 0 && (
				<>
					<h4 className="fg-label mt-5 text-fg">{t("settings.project.release.owed")}</h4>
					<ul className="divide-y divide-line-subtle">
						{knowledge.map((g) => (
							<KnowledgeGap key={g} projectId={projectId} slug={g} gap={KNOWLEDGE_GAPS[g] as NonNullable<(typeof KNOWLEDGE_GAPS)[Gap]>} />
						))}
						{fields.map((g) => {
							const gap = FIELD_GAPS[g] as NonNullable<(typeof FIELD_GAPS)[Gap]>;
							return (
								<li key={g} className="flex items-start gap-2 py-2 text-13" data-gap={g}>
									<Dot tone="attention" />
									<p className="min-w-0 flex-1">
										{t(gap.why)}{" "}
										<Link href={settingsHref(slug, gap.section, gap.anchor)} className="font-semibold text-link hover:underline">
											{t(gap.act)}
										</Link>
									</p>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}
