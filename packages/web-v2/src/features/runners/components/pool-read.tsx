"use client";

import { Banner } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import type { RunnerPoolRead } from "../types";

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
 * status came back.
 */
export function PoolReadBanner({
	poolRead,
}: {
	poolRead: RunnerPoolRead | null | undefined;
}) {
	if (!poolRead) return null;
	const { lastFailure } = poolRead;

	if (poolRead.verdict === "blind") {
		return (
			<Banner tone="danger">
				<span className="font-semibold">
					This box cannot read the project's job pool
				</span>{" "}
				— unread since {ago(poolRead.unreadSince)}, {poolRead.consecutive}{" "}
				consecutive failed read(s). Newest:{" "}
				<code className="font-mono text-12">{lastFailure.what}</code>. It sees no
				queue while this lasts, which is not the same as an empty one.
			</Banner>
		);
	}

	const count = poolRead.countIsFloor
		? `At least ${poolRead.failures}`
		: `${poolRead.failures}`;
	return (
		<Banner tone="attention">
			<span className="font-semibold">
				{count} failed pool read(s) in the last {windowLabel(poolRead.windowMs)}
			</span>{" "}
			— newest {ago(lastFailure.at)}:{" "}
			<code className="font-mono text-12">{lastFailure.what}</code>. Reading
			again since {ago(poolRead.recoveredAt)}.
		</Banner>
	);
}
