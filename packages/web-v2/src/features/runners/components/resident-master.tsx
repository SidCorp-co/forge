
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ResidentMaster as ResidentMasterRow } from "../types";

/**
 * The resident master, on the surface that governs the box (ISS-1118). What
 * core holds is a REGISTRATION and not a pane, so "last reported" is printed
 * rather than smoothed into a green dot. No control is offered, because the box
 * ledger is the only writer of a master's standing.
 */
export function ResidentMaster({ master }: { master: ResidentMasterRow | null | undefined }) {
	const t = useCopy();
	const time = useTimeFormat();

	return (
		<div className="flex flex-col gap-1 border-line border-t pt-3">
			<div className="fg-body-sm text-fg">{t("runners.master.title")}</div>
			{master === undefined ? (
				<p className="fg-caption text-muted">{t("runners.master.unreported")}</p>
			) : master ? (
				<p className="fg-caption text-muted">
					{t("runners.master.registered")} <code>{master.name || t("runners.master.unnamed")}</code>.{" "}
					{t("runners.master.lastReported", { when: time.relative(master.lastHeartbeatAt) || t("overview.never") })}
				</p>
			) : (
				<p className="fg-caption text-muted">{t("runners.master.none")}</p>
			)}
		</div>
	);
}
