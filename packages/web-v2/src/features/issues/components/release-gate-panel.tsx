"use client";

import { Badge, Button, Card, EmptyState, MonoTag } from "@/design";
import { useState } from "react";
import { useBatchRelease, useReleaseRoster } from "../hooks";
import type { ReleaseRosterEntry } from "../api";

/** Whole days until `iso`, or null when there is nothing to count toward. */
function daysUntil(iso: string | null): number | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime() - Date.now();
	return Number.isNaN(ms) ? null : Math.max(0, Math.ceil(ms / 86_400_000));
}

function formatCountdown(iso: string | null): string {
	if (!iso) return "";
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms)) return "";
	if (ms <= 0) return "any moment now";
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
	if (hours < 48) return `in ${hours}h`;
	return `in ${daysUntil(iso)} days`;
}

/**
 * Everything waiting to ship, and when it will. The two honest-degradation
 * rules live here: with no schedule this says so in words instead of counting
 * toward a cut nothing will perform, and an issue already claimed by a running
 * batch is shown as shipping rather than as selectable.
 */
export function ReleaseGatePanel({ projectId }: { projectId: string }) {
	const { data, isLoading } = useReleaseRoster(projectId);
	const batch = useBatchRelease(projectId);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	if (isLoading || !data) return null;
	if (!data.gateStatus) return null;

	const selectable = data.issues.filter((i) => i.claimedByRunId === null);
	const toggle = (id: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const chosen = selectable.filter((i) => selected.has(i.id)).map((i) => i.id);
	const oldest = data.issues[0]?.waitingDays ?? null;

	return (
		<Card>
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<span className="fg-title-sm text-fg">Awaiting release</span>
						<Badge tone="cobalt">{data.issues.length}</Badge>
					</div>
					<span className="fg-body-xs text-fg-muted">
						{data.nextCutAt
							? `Next cut ${formatCountdown(data.nextCutAt)}`
							: "No schedule — waiting for a person"}
						{oldest != null && data.issues.length > 0
							? ` · oldest merged ${oldest} day${oldest === 1 ? "" : "s"} ago`
							: ""}
					</span>
				</div>
				<Button
					size="sm"
					disabled={chosen.length === 0 || batch.isPending}
					onClick={() => batch.mutate({ issueIds: chosen })}
				>
					Release {chosen.length > 0 ? `${chosen.length} now` : "now"}
				</Button>
			</div>

			<div className="fg-body-xs text-fg-muted mt-2 flex flex-wrap gap-3">
				<span>
					Deploys via <MonoTag>{data.channel ?? "nothing — a person deploys"}</MonoTag>
				</span>
				{data.releaseRunnerLabel ? (
					<span>
						Only runners labelled <MonoTag>{data.releaseRunnerLabel}</MonoTag> may ship it
					</span>
				) : null}
			</div>

			{data.issues.length === 0 ? (
				<EmptyState title="Nothing is waiting" message="Merged work lands here until a release ships it." mascot={false} />
			) : (
				<ul className="mt-3 flex flex-col gap-1">
					{data.issues.map((issue) => (
						<RosterRow
							key={issue.id}
							issue={issue}
							checked={selected.has(issue.id)}
							onToggle={() => toggle(issue.id)}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}

function RosterRow({
	issue,
	checked,
	onToggle,
}: {
	issue: ReleaseRosterEntry;
	checked: boolean;
	onToggle: () => void;
}) {
	const claimed = issue.claimedByRunId !== null;
	return (
		<li className="flex items-center gap-2">
			<input
				type="checkbox"
				checked={checked}
				disabled={claimed}
				onChange={onToggle}
				aria-label={`Select ${issue.displayId} for release`}
			/>
			<MonoTag>{issue.displayId}</MonoTag>
			<span className="fg-body-sm text-fg truncate">{issue.title}</span>
			<span className="fg-body-xs text-fg-muted ml-auto whitespace-nowrap">
				{claimed
					? "shipping now"
					: issue.waitingDays == null
						? "merge time unknown"
						: `waiting ${issue.waitingDays}d`}
			</span>
		</li>
	);
}
