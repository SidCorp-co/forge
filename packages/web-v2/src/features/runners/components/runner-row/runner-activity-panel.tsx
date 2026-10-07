import { EnumBadge, ErrorState, Skeleton, StatusBadge, statusReading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRunnerActivity } from "../../hooks";

/** Lazy-loaded activity feed for one runner: status timeline + recent sessions. */
export function RunnerActivityPanel({ runnerId }: { runnerId: string }) {
	const activity = useRunnerActivity(runnerId, true);
	const t = useCopy();
	const time = useTimeFormat();
	const language = useInterfaceLanguage();

	if (activity.isLoading) {
		return <Skeleton className="h-24 w-full" />;
	}
	if (activity.isError) {
		return (
			<ErrorState
				message={formatApiError(activity.error)}
				onRetry={() => activity.refetch()}
			/>
		);
	}
	const events = activity.data?.events ?? [];
	const sessions = activity.data?.sessions ?? [];
	const retentionDays = activity.data?.retentionDays;
	if (events.length === 0 && sessions.length === 0) {
		return (
			<p className="fg-body-sm text-subtle">
				{t("runners.activity.none")}
				{typeof retentionDays === "number" ? ` ${t("runners.activity.retention", { n: retentionDays })}` : null}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4 border-l-2 border-line-subtle pl-3">
			{sessions.length > 0 && (
				<div className="flex flex-col gap-2">
					<span className="fg-label">{t("runners.activity.sessions")}</span>
					{sessions.map((s) => (
						<div
							key={s.id}
							className="flex flex-col gap-1 border-t border-line-subtle py-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-13 text-fg">
									{s.title ?? t("runners.activity.untitled")}
								</span>
								<span className="fg-caption flex-none text-subtle">
									{time.relative(s.updatedAt)}
								</span>
							</div>
							<div className="flex items-center gap-1.5">
								<StatusBadge family="session" value={s.status} />
								{s.failureReason && <EnumBadge family="failureCause" value={s.failureReason} />}
							</div>
							{s.errorExcerpt && (
								<code className="whitespace-pre-wrap break-words font-mono text-11 text-[color:var(--red-600)]">
									{s.errorExcerpt}
								</code>
							)}
						</div>
					))}
				</div>
			)}

			{events.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<span className="fg-label">{t("runners.activity.history")}</span>
					{events.map((e) => (
						<div
							key={e.id}
							className="flex items-center justify-between gap-2 text-12"
						>
							<span className="text-fg">
								{e.oldStatus ? `${statusReading("device", e.oldStatus, language).label} → ` : ""}
								<span className="font-semibold">{statusReading("device", e.newStatus, language).label}</span>
								{e.reason && (
									<span className="text-subtle">
										{" · "}
										<code className="font-mono text-11">{e.reason}</code>
									</span>
								)}
							</span>
							<span className="fg-caption flex-none text-subtle">
								{time.relative(e.ts)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
