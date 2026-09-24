"use client";

import { Banner } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import type { RunnerPoolRead } from "../types";

/**
 * A box beats every 30 seconds and every beat carries its whole pool picture,
 * so a report older than ten missed beats is one the box has stopped renewing.
 */
export const POOL_READ_STALE_MS = 5 * 60_000;

const ago = (ms: number | null) =>
	formatRelativeTime(ms === null ? null : new Date(ms).toISOString(), {
		emptyLabel: "at an unrecorded time",
	});

/** "24h" for the window the box reported, whatever it was. */
function windowLabel(ms: number): string {
	const hours = Math.round(ms / 3_600_000);
	return hours >= 1 ? `${hours}h` : `${Math.round(ms / 60_000)}m`;
}

/**
 * A box that could not read this project's job pool (ISS-1234). A failed read
 * must never read as an empty pool, so this names it where the runner is read.
 * `what` is the status by number and name, or the transport's reason where no
 * status came back. A report the box stopped renewing is kept and dated, never
 * stated in the present tense.
 */
export function PoolReadBanner({
	poolRead,
	now = Date.now(),
}: {
	poolRead: RunnerPoolRead | null | undefined;
	now?: number;
}) {
	if (!poolRead) return null;
	const { lastFailure } = poolRead;
	const heard = Date.parse(poolRead.receivedAt);
	const stale = Number.isNaN(heard) || now - heard > POOL_READ_STALE_MS;
	const asOf = stale ? (
		<>
			{" "}
			This is the box's last report,{" "}
			{formatRelativeTime(poolRead.receivedAt, { emptyLabel: "at an unrecorded time" })}
			; nothing newer has arrived from it.
		</>
	) : null;

	if (poolRead.verdict === "blind") {
		return (
			<Banner tone="danger">
				<span className="font-semibold">
					{stale
						? "This box could not read the project's job pool when it last reported"
						: "This box cannot read the project's job pool"}
				</span>{" "}
				— unread since {ago(poolRead.unreadSince)}, {poolRead.consecutive}{" "}
				consecutive failed read(s). Newest:{" "}
				<code className="font-mono text-12">{lastFailure.what}</code>. It sees no
				queue while this lasts, which is not the same as an empty one.{asOf}
			</Banner>
		);
	}

	const count = poolRead.countIsFloor
		? `At least ${poolRead.failures}`
		: `${poolRead.failures}`;
	const window = windowLabel(poolRead.windowMs);
	return (
		<Banner tone="attention">
			<span className="font-semibold">
				{count} failed pool read(s){" "}
				{stale ? `in the ${window} before its last report` : `in the last ${window}`}
			</span>{" "}
			— newest {ago(lastFailure.at)}:{" "}
			<code className="font-mono text-12">{lastFailure.what}</code>. Reading
			again since {ago(poolRead.recoveredAt)}.{asOf}
		</Banner>
	);
}
