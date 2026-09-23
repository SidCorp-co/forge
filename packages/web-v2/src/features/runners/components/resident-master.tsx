"use client";

import { formatRelativeTime } from "@/lib/utils/format";
import type { ResidentMaster as ResidentMasterRow } from "../types";

/**
 * The resident master, on the surface that governs the box (ISS-1118). What
 * core holds is a REGISTRATION and not a pane, so "last reported" is printed
 * rather than smoothed into a green dot; the control is named and not offered,
 * and `docs/proposals/master-standing-at-core.md` says why.
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
	const named = slug ?? "<project>";
	const where = deviceName ? `on ${deviceName}` : "on that device";

	return (
		<div className="flex flex-col gap-1 border-line border-t pt-3">
			<div className="fg-body-sm text-fg">Resident master session</div>
			{master === undefined ? (
				<p className="fg-caption text-muted">
					This server does not report resident master sessions, so whether this box
					is running one for this project cannot be answered here.
				</p>
			) : master ? (
				<p className="fg-caption text-muted">
					One is registered on this box for this project:{" "}
					<code>{master.name || "unnamed session"}</code>. It last reported{" "}
					{formatRelativeTime(master.lastHeartbeatAt, {
						emptyLabel: "never",
					})}
					. That is what the box told this server, not what its terminal is doing
					now — a box that went quiet without reporting the session closed still
					reads as registered.
				</p>
			) : (
				<p className="fg-caption text-muted">
					No resident master session is registered on this box for this project
					right now.
				</p>
			)}

			<p className="fg-caption text-muted">
				The pool control above does not govern it, and neither does turning the
				device off: both decide whether work is offered, and neither ends a
				session already running.
			</p>
			<p className="fg-caption text-muted">
				To stop one, run{" "}
				<code>forge-runner master stand-down {named}</code> {where}. That always
				stops a replacement being placed, and it leaves the running session
				alone where that session still holds live runs or where the box cannot
				establish what it holds; adding <code>--force</code> ends it together
				with the work it was holding. <code>forge-runner master stand-up{" "}
				{named}</code> puts the project back.
			</p>
		</div>
	);
}
