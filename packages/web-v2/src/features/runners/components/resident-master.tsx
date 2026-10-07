"use client";

import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ResidentMaster as ResidentMasterRow } from "../types";

/**
 * The resident master, on the surface that governs the box (ISS-1118). What
 * core holds is a REGISTRATION and not a pane, so "last reported" is printed
 * rather than smoothed into a green dot; the control is named and not offered,
 * because the box ledger is the only writer of a master's standing.
 */
export function ResidentMaster({
	master,
	slug,
	deviceName,
}: {
	master: ResidentMasterRow | null | undefined;
	slug: string | undefined;
	deviceName: string | null;
}) {
	const t = useCopy();
	const time = useTimeFormat();
	const named = slug ?? "<project>";
	const where = deviceName ? t("runners.master.onDevice", { name: deviceName }) : t("runners.master.onThatDevice");

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

			<p className="fg-caption text-muted">{t("runners.master.notGoverned")}</p>
			<p className="fg-caption text-muted">
				{t("runners.master.toStop")} <code>forge-runner master stand-down {named}</code> {where}. {t("runners.master.standDown")}{" "}
				<code>--force</code> {t("runners.master.force")} <code>forge-runner master stand-up {named}</code> {t("runners.master.standUp")}
			</p>
		</div>
	);
}
