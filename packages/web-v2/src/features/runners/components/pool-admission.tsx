
import { Toggle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useSetRunnerAdmission } from "../hooks";

/**
 * Whether this runner may be offered jobs from the pool.
 *
 * Neither `draining` nor `disabled` ends a master pane already up (ISS-1118):
 * both decide only whether a NEW master is placed.
 */
export function PoolAdmission({
	projectId,
	runnerId,
	status,
	canEdit,
}: {
	projectId: string;
	runnerId: string;
	status: string;
	canEdit: boolean;
}) {
	const set = useSetRunnerAdmission(projectId);
	const withdrawn = status === "draining" || status === "disabled";
	const t = useCopy();

	return (
		<div className="flex items-start gap-3 border-line border-t pt-3">
			<Toggle
				checked={!withdrawn}
				onChange={(next) => set.mutate({ runnerId, admit: next })}
				disabled={!canEdit || set.isPending}
				aria-label={t("runners.pool.toggle")}
			/>
			<div className="min-w-0">
				<div className="fg-body-sm text-fg">{t("runners.pool.takes")}</div>
				<p className="fg-caption text-muted">
					{status === "disabled" ? t("runners.pool.retired") : withdrawn ? t("runners.pool.drained") : t("runners.pool.offered")}
				</p>
			</div>
		</div>
	);
}
