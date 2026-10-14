
import { Badge, Banner, ErrorState, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { canonicalJson } from "@forge/contracts/document-patch";
import { formatApiError } from "@/lib/api/error";
import { useEffectiveConfig } from "@/features/project-config";
import type { EffectiveLayer } from "@/features/project-config";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";

const layerText = (t: Copy, layer: EffectiveLayer) => t(`settings.project.raw.layer.${layer}` as ProductCopyKey);

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);

export function EffectiveConfig({ projectId }: { projectId: string }) {
	const t = useCopy();
	const q = useEffectiveConfig(projectId);
	if (q.isLoading) return <Skeleton className="mt-6 h-32 w-full rounded-md" />;
	if (!q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
	const e = q.data;
	return (
		<section aria-label={t("settings.project.raw.effective")} className="pb-4">
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
