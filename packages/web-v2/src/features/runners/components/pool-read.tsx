"use client";

import { Banner, useNow } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { RunnerPoolRead } from "../types";

/**
 * A box beats every 30 seconds and every beat carries its whole pool picture,
 * so a report older than ten missed beats is one the box has stopped renewing.
 */
export const POOL_READ_STALE_MS = 5 * 60_000;



/**
 * A box that could not read this project's job pool (ISS-1234). A failed read
 * must never read as an empty pool, so this names it where the runner is read.
 * `what` is the status by number and name, or the transport's reason where no
 * status came back. A report the box stopped renewing is kept and dated, never
 * stated in the present tense.
 */
export function PoolReadBanner({
	poolRead,
	now: given,
}: {
	poolRead: RunnerPoolRead | null | undefined;
	now?: number;
}) {
	// An open page must see a report go stale without a re-render from above.
	const ticking = useNow(30_000, Boolean(poolRead) && given === undefined);
	const now = given ?? ticking;
	const t = useCopy();
	const time = useTimeFormat();
	if (!poolRead) return null;
	const ago = (ms: number | null) => (ms === null ? "" : time.relative(new Date(ms).toISOString(), now)) || t("runners.poolRead.unrecorded");
	/** "24h" for the window the box reported, whatever it was. */
	const windowLabel = (ms: number) => {
		const hours = Math.round(ms / 3_600_000);
		return hours >= 1 ? t("common.age.hours", { n: hours }) : t("common.age.minutes", { n: Math.round(ms / 60_000) });
	};
	const { lastFailure } = poolRead;
	const heard = Date.parse(poolRead.receivedAt);
	const stale = Number.isNaN(heard) || now - heard > POOL_READ_STALE_MS;
	const asOf = stale ? <> {t("runners.poolRead.lastReport", { when: time.relative(poolRead.receivedAt, now) || t("runners.poolRead.unrecorded") })}</> : null;

	if (poolRead.verdict === "blind") {
		return (
			<Banner tone="danger">
				<span className="font-semibold">{stale ? t("runners.poolRead.blindStale") : t("runners.poolRead.blind")}</span>{" "}
				— {t("runners.poolRead.unreadSince", { since: ago(poolRead.unreadSince), n: poolRead.consecutive })}{" "}
				<code className="font-mono text-12">{lastFailure.what}</code>. {t("runners.poolRead.noQueue")}
				{asOf}
			</Banner>
		);
	}

	const count = poolRead.countIsFloor ? t("runners.poolRead.atLeast", { n: poolRead.failures }) : `${poolRead.failures}`;
	const window = windowLabel(poolRead.windowMs);
	return (
		<Banner tone="attention">
			<span className="font-semibold">
				{stale ? t("runners.poolRead.failedBefore", { count, window }) : t("runners.poolRead.failedLast", { count, window })}
			</span>{" "}
			— {t("runners.poolRead.newest", { when: ago(lastFailure.at) })}{" "}
			<code className="font-mono text-12">{lastFailure.what}</code>. {t("runners.poolRead.readingAgain", { when: ago(poolRead.recoveredAt) })}
			{asOf}
		</Banner>
	);
}
