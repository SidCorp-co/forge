import { EnumBadge, ErrorState, Skeleton, StatusBadge, sentenceCase, statusReading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRunnerActivity } from "../../hooks";

/** Lazy-loaded activity feed for one runner: status timeline + recent sessions. */
export function RunnerActivityPanel({ runnerId }: { runnerId: string }) {
	const activity = useRunnerActivity(runnerId, true);

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
				No recorded activity yet.
				{typeof retentionDays === "number"
					? ` Status history is kept for ${retentionDays} days.`
					: null}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4 rounded-lg border border-line bg-sunken p-3">
			{sessions.length > 0 && (
				<div className="flex flex-col gap-2">
					<span className="fg-label">Recent sessions on this device</span>
					{sessions.map((s) => (
						<div
							key={s.id}
							className="flex flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2"
						>
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-13 text-fg">
									{s.title ?? "Untitled session"}
								</span>
								<span className="fg-caption flex-none text-subtle">
									{formatRelativeTime(s.updatedAt)}
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
					<span className="fg-label">Status history</span>
					{events.map((e) => (
						<div
							key={e.id}
							className="flex items-center justify-between gap-2 text-12"
						>
							<span className="text-fg">
								{e.oldStatus ? `${statusReading("device", e.oldStatus).label} → ` : ""}
								<span className="font-semibold">{statusReading("device", e.newStatus).label}</span>
								{e.reason && (
									<span className="text-subtle"> · {sentenceCase(e.reason)}</span>
								)}
							</span>
							<span className="fg-caption flex-none text-subtle">
								{formatRelativeTime(e.ts)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
